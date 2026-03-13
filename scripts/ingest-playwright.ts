#!/usr/bin/env node
/**
 * ingest-playwright.ts
 *
 * Ingests a Playwright JSON reporter output file (--reporter=json) into:
 *   Build              — upserted by (ciProvider, jobName, buildNumber)
 *   RawArtifact        — the JSON file itself
 *   CiRun              — one row per invocation (shard-aware)
 *   TestExecution      — one row per test × Playwright project
 *   TestAttempt        — one row per attempt/retry within each execution
 *   JiraAutomationLink — EXPLICIT HIGH-confidence links from @tag annotations
 *
 * Safe to re-run on the same file: CiRun is always newly created (a second
 * ingest of the same shard creates a second CiRun, which is correct — you
 * retried the shard).  TestExecution rows inside a run are upserted by
 * (runId, testId, project, shardIndex).  TestAttempt rows are upserted by
 * (executionId, attemptNo).
 *
 * Usage:
 *   npm run etl:ingest:playwright -- \
 *     --json-path ./pw-results.json \
 *     --job my-jenkins-job \
 *     --build 456
 *
 *   # Shard 0 of 4, Chrome only
 *   npm run etl:ingest:playwright -- \
 *     --json-path ./results-shard0.json \
 *     --job my-jenkins-job --build 456 \
 *     --shard-index 0 --shard-total 4 \
 *     --project chromium
 *
 *   npm run etl:ingest:playwright -- ... --dry-run --explain
 *
 * Jira link extraction from @tags
 * ────────────────────────────────
 * Any spec tag containing a Jira key pattern (e.g. "@QAA-123", "QAA-123",
 * or a full URL "https://jira.example.com/browse/QAA-123") automatically
 * produces a jira_automation_link row with confidence=HIGH, provenance=EXPLICIT.
 * Use --skip-jira-links to disable this behaviour.
 */

import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { z } from "zod";

import { prisma } from "./db/prisma";

// ── Playwright JSON reporter types ────────────────────────────────────────────
// Matches the shape emitted by `npx playwright test --reporter=json`.

interface PWReport {
  config?: unknown;
  suites: PWSuite[];
  stats: {
    startTime: string; // ISO-8601
    duration: number;  // ms
    expected: number;
    skipped: number;
    unexpected: number;
    flaky: number;
  };
  errors: PWError[];
}

interface PWSuite {
  title: string;
  file?: string;   // set on file-level suites only
  column?: number;
  line?: number;
  specs: PWSpec[];
  suites?: PWSuite[];
}

interface PWSpec {
  title: string;
  ok: boolean;
  tags: string[];
  tests: PWTest[];
  id: string;
  file: string;
  line: number;
  column: number;
}

interface PWTest {
  timeout: number;
  annotations: Array<{ type: string; description?: string }>;
  expectedStatus: string;
  projectId: string;
  projectName: string;
  results: PWResult[];
  status: "expected" | "unexpected" | "flaky" | "skipped";
}

interface PWResult {
  workerIndex: number;
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  duration: number; // ms
  errors: PWError[];
  stdout: Array<{ text?: string; buffer?: string }>;
  stderr: Array<{ text?: string; buffer?: string }>;
  retry: number;     // 0-based retry index
  startTime: string; // ISO-8601
  attachments: PWAttachment[];
  steps: unknown[];
}

interface PWAttachment {
  name: string;
  contentType: string;
  path?: string;
  body?: string;
}

interface PWError {
  message?: string;
  location?: { file: string; line: number; column: number };
  snippet?: string;
  value?: string;
}

// ── Collected spec ────────────────────────────────────────────────────────────

interface CollectedSpec {
  spec: PWSpec;
  describePath: string[]; // describe() block titles (file name excluded)
  filePath: string;
}

// ── CLI args ──────────────────────────────────────────────────────────────────

const IngestArgsSchema = z.object({
  jsonPath:      z.string().min(1),
  ciProvider:    z.string().default("jenkins"),
  jobName:       z.string().min(1),
  buildNumber:   z.coerce.number().int().nonnegative(),
  buildUrl:      z.string().optional(),
  gitSha:        z.string().optional(),
  branch:        z.string().optional(),
  environment:   z.string().optional(),
  prNumber:      z.string().optional(),
  shardIndex:    z.coerce.number().int().min(0).optional(),
  shardTotal:    z.coerce.number().int().min(1).optional(),
  projectFilter:  z.string().optional(),
  skipJiraLinks:  z.boolean().default(false),
  dryRun:         z.boolean().default(false),
  explain:        z.boolean().default(false),
});

type IngestArgs = z.infer<typeof IngestArgsSchema>;

// ── Status helpers ────────────────────────────────────────────────────────────

/** Playwright test.status → ExecutionStatus */
function toExecutionStatus(
  s: "expected" | "unexpected" | "flaky" | "skipped"
): "PASSED" | "FAILED" | "FLAKY" | "SKIPPED" | "ERROR" {
  switch (s) {
    case "expected":   return "PASSED";
    case "unexpected": return "FAILED";
    case "flaky":      return "FLAKY";
    case "skipped":    return "SKIPPED";
    default:           return "ERROR";
  }
}

/** Playwright result.status → AttemptStatus */
function toAttemptStatus(s: string): "PASSED" | "FAILED" | "SKIPPED" {
  if (s === "passed")  return "PASSED";
  if (s === "skipped") return "SKIPPED";
  return "FAILED"; // failed | timedOut | interrupted
}

/** Derive overall CiRun status from report stats. */
function ciRunStatus(
  stats: PWReport["stats"]
): "PASSED" | "FAILED" | "FLAKY" | "SKIPPED" | "ERROR" {
  if (stats.unexpected > 0) return "FAILED";
  if (stats.flaky > 0)      return "FLAKY";
  if (stats.expected === 0 && stats.skipped > 0) return "SKIPPED";
  return "PASSED";
}

// ── Jira tag extraction ───────────────────────────────────────────────────────

interface TagJiraMatch {
  issueKey: string;
  tagValue: string; // the raw tag string the key was found in
}

/**
 * Scan a spec's tags array for Jira issue keys.
 * Handles: "@QAA-123", "QAA-123", "https://jira.example.com/browse/QAA-123"
 * Uses the same boundary regex as infer-jira-links (treats _ as separator).
 * Returns deduplicated matches — first tag that contains a key wins.
 */
function extractJiraKeysFromTags(tags: string[]): TagJiraMatch[] {
  const seen    = new Set<string>();
  const results: TagJiraMatch[] = [];
  for (const tag of tags) {
    const re = /(?<![A-Z0-9])([A-Z][A-Z0-9]{1,9}-\d+)(?!\d)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tag)) !== null) {
      const key = m[1];
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ issueKey: key, tagValue: tag });
      }
    }
  }
  return results;
}

// ── Suite walker ──────────────────────────────────────────────────────────────

/**
 * Recursively walk the Playwright suite tree and collect every spec with its
 * describe-block path and source file.
 *
 * The top-level suites represent files (suite.file is set; title = file path).
 * We skip adding the file-level title to describePath.
 * Inner suites represent describe() blocks.
 */
function walkSuites(
  suites: PWSuite[],
  describePath: string[],
  parentFile: string
): CollectedSpec[] {
  const all: CollectedSpec[] = [];

  for (const suite of suites) {
    const isFileSuite   = !!suite.file;
    const effectiveFile = suite.file || parentFile;

    // Only push non-empty describe titles (skip the file-level wrapper)
    const nextPath = isFileSuite
      ? describePath
      : suite.title
        ? [...describePath, suite.title]
        : describePath;

    if (suite.suites?.length) {
      all.push(...walkSuites(suite.suites, nextPath, effectiveFile));
    }

    for (const spec of suite.specs ?? []) {
      all.push({
        spec,
        describePath: nextPath,
        filePath: spec.file || effectiveFile,
      });
    }
  }

  return all;
}

// ── Misc helpers ──────────────────────────────────────────────────────────────

function sha256Buf(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Short 16-char hex hash of the first error message, normalized to reduce
 * noise from line numbers and absolute paths.  Used to group similar failures.
 */
function hashFirstError(errors: PWError[]): string | null {
  const msg = errors[0]?.message;
  if (!msg) return null;
  const norm = msg
    .replace(/\d+:\d+/g, "0:0")                         // line:col refs
    .replace(/\/[^\s]*\.(spec|test)\.(ts|js)/g, "<f>");  // abs file paths
  return crypto.createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

/**
 * Build an artifactLinks map from Playwright attachments.
 * Keys are lower-cased attachment names (spaces → _).
 * Only includes attachments that have a file path.
 */
function buildArtifactLinks(
  attachments: PWAttachment[]
): Record<string, string> | null {
  const map: Record<string, string> = {};
  for (const att of attachments) {
    if (att.path) {
      map[att.name.toLowerCase().replace(/\s+/g, "_")] = att.path;
    }
  }
  return Object.keys(map).length ? map : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("ingest-playwright")
    .usage(
      "$0 --json-path <file> --job <jobName> --build <n> [options]\n\n" +
      "Ingest a Playwright JSON reporter file into the test-intel database."
    )
    .option("json-path",   { type: "string",  demandOption: true, describe: "Path to Playwright JSON reporter output" })
    .option("job",         { type: "string",  demandOption: true, describe: "CI job full name" })
    .option("build",       { type: "number",  demandOption: true, describe: "Build number" })
    .option("ci",          { type: "string",  default: "jenkins", describe: "CI provider" })
    .option("build-url",   { type: "string" })
    .option("git-sha",     { type: "string" })
    .option("branch",      { type: "string" })
    .option("environment", { type: "string" })
    .option("pr-number",   { type: "string" })
    .option("shard-index", { type: "number",  describe: "0-based shard index (omit if not sharding)" })
    .option("shard-total", { type: "number",  describe: "Total shard count" })
    .option("project",          { type: "string",  describe: "Filter to a single Playwright project name" })
    .option("skip-jira-links",  { type: "boolean", default: false, describe: "Skip writing jira_automation_link rows from @tags" })
    .option("dry-run",          { type: "boolean", default: false, describe: "Parse and validate; do not write to DB" })
    .option("explain",          { type: "boolean", default: false, describe: "Verbose per-test output" })
    .help()
    .parse();

  const args = IngestArgsSchema.parse({
    jsonPath:      argv["json-path"],
    ciProvider:    argv["ci"],
    jobName:       argv["job"],
    buildNumber:   argv["build"],
    buildUrl:      argv["build-url"],
    gitSha:        argv["git-sha"],
    branch:        argv["branch"],
    environment:   argv["environment"],
    prNumber:      argv["pr-number"],
    shardIndex:    argv["shard-index"],
    shardTotal:    argv["shard-total"],
    projectFilter:  argv["project"],
    skipJiraLinks:  argv["skip-jira-links"],
    dryRun:         argv["dry-run"],
    explain:        argv["explain"],
  });

  // ── Read + parse JSON ───────────────────────────────────────────────────────

  const absPath = path.resolve(args.jsonPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Playwright JSON file not found: ${absPath}`);
  }

  const buf     = fs.readFileSync(absPath);
  const fileSha = sha256Buf(buf);
  const report  = JSON.parse(buf.toString("utf-8")) as PWReport;

  if (!report.stats || !Array.isArray(report.suites)) {
    throw new Error(
      "File does not look like a Playwright JSON reporter output. " +
      "Run tests with: npx playwright test --reporter=json"
    );
  }

  const { stats } = report;
  const startedAt  = new Date(stats.startTime);
  const finishedAt = new Date(startedAt.getTime() + stats.duration);
  const runStatus  = ciRunStatus(stats);

  if (args.explain) {
    console.log(`[explain] jsonPath=${absPath}  sha256=${fileSha.slice(0, 12)}…`);
    console.log(
      `[explain] stats: expected=${stats.expected} skipped=${stats.skipped}` +
      ` unexpected=${stats.unexpected} flaky=${stats.flaky}` +
      ` duration=${stats.duration}ms → runStatus=${runStatus}`
    );
  }

  // ── Collect test items ──────────────────────────────────────────────────────

  const collected = walkSuites(report.suites, [], "");

  interface WorkItem {
    cs:        CollectedSpec;
    test:      PWTest;
    testId:    string;   // stable ID: filePath::describe > ... > title
    titlePath: string[]; // [describe1, ..., testTitle]
  }

  const workItems: WorkItem[] = [];
  for (const cs of collected) {
    for (const test of cs.spec.tests) {
      if (args.projectFilter && test.projectName !== args.projectFilter) continue;
      const titlePath = [...cs.describePath, cs.spec.title];
      const testId    = `${cs.filePath}::${titlePath.join(" > ")}`;
      workItems.push({ cs, test, testId, titlePath });
    }
  }

  if (args.explain) {
    console.log(`[explain] suites found: ${report.suites.length}`);
    console.log(`[explain] specs collected: ${collected.length}`);
    console.log(`[explain] work items (test×project): ${workItems.length}`);
    if (!args.skipJiraLinks) {
      const tagLinkCount = collected.reduce(
        (s, cs) => s + extractJiraKeysFromTags(cs.spec.tags).length, 0
      );
      console.log(`[explain] Jira keys found in spec tags: ${tagLinkCount}`);
    } else {
      console.log("[explain] Jira link extraction disabled (--skip-jira-links)");
    }
  }

  // ── Dry-run exit ────────────────────────────────────────────────────────────

  if (args.dryRun) {
    const totalAttempts = workItems.reduce((s, w) => s + w.test.results.length, 0);
    console.log("[dry-run] Playwright JSON parsed successfully.");
    console.log(`[dry-run] job=${args.jobName} #${args.buildNumber} ci=${args.ciProvider}`);
    console.log(`[dry-run] runStatus=${runStatus}  startedAt=${startedAt.toISOString()}`);
    console.log(`[dry-run] testExecutions=${workItems.length}  totalAttempts=${totalAttempts}`);
    if (!args.skipJiraLinks) {
      // Deduplicate by specId so we show per-spec, not per-project (tags are on the spec)
      const seen = new Set<string>();
      const tagLinks: string[] = [];
      for (const w of workItems) {
        if (seen.has(w.cs.spec.id)) continue;
        seen.add(w.cs.spec.id);
        for (const { issueKey, tagValue } of extractJiraKeysFromTags(w.cs.spec.tags)) {
          tagLinks.push(`  ${w.testId} → ${issueKey}  (tag: "${tagValue}")`);
        }
      }
      if (tagLinks.length > 0) {
        console.log(`[dry-run] jiraLinks that would be written (${tagLinks.length}):`);
        tagLinks.forEach((l) => console.log(l));
      } else {
        console.log("[dry-run] No Jira keys found in spec tags.");
      }
    }
    if (args.explain) {
      const preview = workItems.slice(0, 20);
      for (const w of preview) {
        const a = w.test.results.length;
        console.log(
          `  [${w.test.status.padEnd(10)}] ${w.test.projectName.padEnd(12)} ` +
          `${w.testId}  (${a} attempt${a !== 1 ? "s" : ""})`
        );
      }
      if (workItems.length > 20) {
        console.log(`  … and ${workItems.length - 20} more`);
      }
    }
    return;
  }

  // ── Write to DB ─────────────────────────────────────────────────────────────

  // 1. Upsert Build
  const build = await prisma.build.upsert({
    where: {
      build_unique_ci_job_number: {
        ciProvider:  args.ciProvider,
        jobName:     args.jobName,
        buildNumber: args.buildNumber,
      },
    },
    create: {
      ciProvider:  args.ciProvider,
      jobName:     args.jobName,
      buildNumber: args.buildNumber,
      buildUrl:    args.buildUrl,
      gitSha:      args.gitSha,
      branch:      args.branch,
      environment: args.environment,
      startedAt,
      finishedAt,
    },
    update: {
      buildUrl:    args.buildUrl    ?? undefined,
      gitSha:      args.gitSha     ?? undefined,
      branch:      args.branch     ?? undefined,
      environment: args.environment ?? undefined,
    },
  });

  // 2. Record artifact
  await prisma.rawArtifact.create({
    data: {
      buildId:      build.id,
      artifactType: "playwright-json",
      storageUri:   `file://${absPath}`,
      sha256:       fileSha,
      bytes:        buf.length,
    },
  });

  // 3. Create CiRun (one per invocation — each shard is its own run)
  const ciRun = await prisma.ciRun.create({
    data: {
      buildId:    build.id,
      branch:     args.branch     ?? null,
      gitSha:     args.gitSha     ?? null,
      jobName:    args.jobName,
      buildNumber: args.buildNumber,
      prNumber:   args.prNumber   ?? null,
      startedAt,
      finishedAt,
      status:     runStatus,
      project:    args.projectFilter ?? null,
      shardIndex: args.shardIndex ?? null,
      shardTotal: args.shardTotal ?? null,
      env:        args.environment ? { environment: args.environment } : undefined,
    },
  });

  if (args.explain) {
    console.log(`[explain] CiRun id=${ciRun.id}`);
  }

  // 4. Pre-load known Jira issue keys for FK safety (only if link writing is on)
  const knownJiraKeys: Set<string> = args.skipJiraLinks
    ? new Set()
    : new Set(
        (await prisma.jiraIssue.findMany({ select: { issueKey: true } }))
          .map((r) => r.issueKey)
      );

  if (args.explain && !args.skipJiraLinks) {
    console.log(`[explain] ${knownJiraKeys.size} Jira issue keys loaded for link filtering`);
  }

  // 5. Upsert TestExecutions + create TestAttempts + write Jira links
  let executionsCreated = 0;
  let executionsUpdated = 0;
  let attemptsWritten   = 0;
  let linksWritten      = 0;
  let linksSkipped      = 0; // key found in tag but not in jira_issue

  for (const { cs, test, testId, titlePath } of workItems) {
    const execStatus  = toExecutionStatus(test.status);
    const totalDurMs  = test.results.reduce((s, r) => s + r.duration, 0);
    const lastResult  = test.results.at(-1);
    const failureMsg  = lastResult?.errors[0]?.message?.slice(0, 2000) ?? null;
    const artifLinks  = lastResult ? buildArtifactLinks(lastResult.attachments) : null;

    // Optional link to TestCase (best-effort; null if not found)
    const tcRow = await prisma.testCase.findFirst({
      where:  { identityKey: testId },
      select: { id: true },
    });

    // Upsert TestExecution via findFirst+create/update to handle nullable
    // (project, shardIndex) in the unique constraint without PG NULL quirks.
    const existing = await prisma.testExecution.findFirst({
      where: {
        runId:      ciRun.id,
        testId,
        project:    test.projectName,
        shardIndex: args.shardIndex ?? null,
      },
      select: { id: true },
    });

    let execution: { id: string };

    if (existing) {
      execution = await prisma.testExecution.update({
        where: { id: existing.id },
        data: {
          status:       execStatus,
          durationMs:   totalDurMs,
          failureMsg,
          artifactLinks: artifLinks ?? undefined,
          testCaseId:   tcRow?.id  ?? undefined,
        },
        select: { id: true },
      });
      executionsUpdated++;
    } else {
      execution = await prisma.testExecution.create({
        data: {
          runId:        ciRun.id,
          testCaseId:   tcRow?.id ?? null,
          testId,
          filePath:     cs.filePath || null,
          titlePath,
          tags:         cs.spec.tags ?? [],
          project:      test.projectName,
          shardIndex:   args.shardIndex ?? null,
          status:       execStatus,
          durationMs:   totalDurMs,
          failureMsg,
          artifactLinks: artifLinks ?? undefined,
        },
        select: { id: true },
      });
      executionsCreated++;
    }

    // Upsert TestAttempts (@@unique([executionId, attemptNo]) — no nullable fields)
    for (const [i, result] of test.results.entries()) {
      const attemptNo  = typeof result.retry === "number" ? result.retry : i;
      const errHash    = hashFirstError(result.errors);
      const attStart   = new Date(result.startTime);
      const attEnd     = new Date(attStart.getTime() + result.duration);

      await prisma.testAttempt.upsert({
        where: {
          executionId_attemptNo: {
            executionId: execution.id,
            attemptNo,
          },
        },
        create: {
          executionId: execution.id,
          attemptNo,
          status:      toAttemptStatus(result.status),
          durationMs:  result.duration,
          errorHash:   errHash,
          startedAt:   attStart,
          finishedAt:  attEnd,
        },
        update: {
          status:    toAttemptStatus(result.status),
          durationMs: result.duration,
          errorHash:  errHash,
        },
      });
      attemptsWritten++;
    }

    // ── Jira link extraction from spec @tags ────────────────────────────────
    // Only process once per spec (tags are per-spec, not per-project).
    // We track which specs we've already processed via the spec id.
    if (!args.skipJiraLinks) {
      const tagMatches = extractJiraKeysFromTags(cs.spec.tags);

      if (tagMatches.length > 0) {
        // Ensure a TestCase row exists — auto-create if the spec wasn't previously seen.
        const tcForLink = await prisma.testCase.upsert({
          where:  { identityKey: testId },
          update: {},
          create: {
            identityKey: testId,
            title:       cs.spec.title,
            suiteName:   cs.filePath || null,
            filePath:    cs.filePath || null,
          },
        });

        // Also back-fill testCaseId on the execution if it was null.
        if (!tcRow) {
          await prisma.testExecution.update({
            where: { id: execution.id },
            data:  { testCaseId: tcForLink.id },
          });
        }

        for (const { issueKey, tagValue } of tagMatches) {
          if (!knownJiraKeys.has(issueKey)) {
            if (args.explain) {
              console.log(`    SKIP link ${issueKey} (not in jira_issue)`);
            }
            linksSkipped++;
            continue;
          }

          await prisma.jiraAutomationLink.upsert({
            where: {
              issueKey_testCaseId_provenance: {
                issueKey,
                testCaseId: tcForLink.id,
                provenance: "EXPLICIT",
              },
            },
            create: {
              issueKey,
              testCaseId: tcForLink.id,
              provenance: "EXPLICIT",
              confidence: "HIGH",
              evidence:   `Playwright tag "${tagValue}"`,
              source:     "playwright-tags",
            },
            update: {
              confidence: "HIGH",
              evidence:   `Playwright tag "${tagValue}"`,
            },
          });

          if (args.explain) {
            console.log(`    LINK ${testId} → ${issueKey}  (tag: "${tagValue}")`);
          }
          linksWritten++;
        }
      }
    }

    if (args.explain) {
      const a = test.results.length;
      console.log(
        `  [${test.status.padEnd(10)}] ${test.projectName.padEnd(12)} ` +
        `${testId}  (${a} attempt${a !== 1 ? "s" : ""})`
      );
    }
  }

  const linkSummary = args.skipJiraLinks
    ? ""
    : `  jiraLinksWritten=${linksWritten} jiraLinksSkipped=${linksSkipped}`;

  console.log(
    `Playwright ingest complete:` +
    `  job=${args.jobName} #${args.buildNumber}` +
    `  ciRunId=${ciRun.id}` +
    `  executionsCreated=${executionsCreated}` +
    `  executionsUpdated=${executionsUpdated}` +
    `  attemptsWritten=${attemptsWritten}` +
    linkSummary +
    `  runStatus=${runStatus}`
  );
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
