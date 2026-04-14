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
 *
 * TestRail explicit link extraction from @tags
 * ─────────────────────────────────────────────
 * Any spec tag containing a TestRail case ID pattern (e.g. "@C1234", "C1234")
 * produces an automation_testrail_link row with confidence=HIGH, provenance=EXPLICIT.
 * Use --skip-tr-links to disable this behaviour.
 */

import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { z } from "zod";

import { prisma } from "./db/prisma";
import { uploadFile, uploadBuffer, buildKey } from "./storage.js";

// ── Playwright JSON reporter types ────────────────────────────────────────────
// Matches the shape emitted by `npx playwright test --reporter=json`.

interface PWReport {
  config?: unknown;
  suites: PWSuite[];
  stats: {
    startTime: string; // ISO-8601
    duration: number; // ms
    expected: number;
    skipped: number;
    unexpected: number;
    flaky: number;
  };
  errors: PWError[];
}

interface PWSuite {
  title: string;
  file?: string; // set on file-level suites only
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
  retry: number; // 0-based retry index
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
  jsonPath: z.string().min(1),
  ciProvider: z.string().default("jenkins"),
  jobName: z.string().min(1),
  buildNumber: z.coerce.number().int().nonnegative(),
  buildUrl: z.string().optional(),
  gitSha: z.string().optional(),
  branch: z.string().optional(),
  environment: z.string().optional(),
  prNumber: z.string().optional(),
  shardIndex: z.coerce.number().int().min(0).optional(),
  shardTotal: z.coerce.number().int().min(1).optional(),
  projectFilter: z.string().optional(),
  skipJiraLinks: z.boolean().default(false),
  skipTrLinks: z.boolean().default(false),
  skipArtifacts: z.boolean().default(false),
  artifactsDir: z.string().optional(), // fallback dir for resolving attachment paths
  extraEnv: z.string().optional(), // JSON string of system-level metadata (node version, OS, etc.)
  dryRun: z.boolean().default(false),
  explain: z.boolean().default(false),
});

type IngestArgs = z.infer<typeof IngestArgsSchema>;

// ── Status helpers ────────────────────────────────────────────────────────────

/** Playwright test.status → ExecutionStatus */
function toExecutionStatus(
  s: "expected" | "unexpected" | "flaky" | "skipped",
): "PASSED" | "FAILED" | "FLAKY" | "SKIPPED" | "ERROR" {
  switch (s) {
    case "expected":
      return "PASSED";
    case "unexpected":
      return "FAILED";
    case "flaky":
      return "FLAKY";
    case "skipped":
      return "SKIPPED";
    default:
      return "ERROR";
  }
}

/** Playwright result.status → AttemptStatus */
function toAttemptStatus(s: string): "PASSED" | "FAILED" | "SKIPPED" {
  if (s === "passed") return "PASSED";
  if (s === "skipped") return "SKIPPED";
  return "FAILED"; // failed | timedOut | interrupted
}

/** Derive overall CiRun status from report stats. */
function ciRunStatus(
  stats: PWReport["stats"],
): "PASSED" | "FAILED" | "FLAKY" | "SKIPPED" | "ERROR" {
  if (stats.unexpected > 0) return "FAILED";
  if (stats.flaky > 0) return "FLAKY";
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
  const seen = new Set<string>();
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

// ── TestRail tag extraction ───────────────────────────────────────────────────

interface TagTrMatch {
  trCaseId: bigint;
  tagValue: string; // the raw tag string the case ID was found in
}

/**
 * Scan a spec's tags array for TestRail case IDs.
 * Handles: "@C1234", "C1234", "TR-C1234"
 * Pattern: optional "@" or "TR-", then "C" followed by digits.
 * Returns deduplicated matches.
 */
function extractTrCaseIdsFromTags(tags: string[]): TagTrMatch[] {
  const seen = new Set<bigint>();
  const results: TagTrMatch[] = [];
  // Matches: @C1234 | C1234 | TR-C1234  (case-insensitive, bounded by non-digits)
  const re = /(?:@|TR-)?[Cc](\d+)(?!\d)/g;
  for (const tag of tags) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tag)) !== null) {
      const id = BigInt(m[1]);
      if (!seen.has(id)) {
        seen.add(id);
        results.push({ trCaseId: id, tagValue: tag });
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
  parentFile: string,
): CollectedSpec[] {
  const all: CollectedSpec[] = [];

  for (const suite of suites) {
    const isFileSuite = !!suite.file;
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
    .replace(/\d+:\d+/g, "0:0") // line:col refs
    .replace(/\/[^\s]*\.(spec|test)\.(ts|js)/g, "<f>"); // abs file paths
  return crypto.createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

/** Derive a RawArtifact artifactType string from MIME type and attachment name. */
function inferArtifactType(contentType: string, name: string): string {
  if (contentType.startsWith("image/")) return "screenshot";
  if (contentType.startsWith("video/")) return "video";
  if (name.toLowerCase().includes("trace") || contentType === "application/zip")
    return "trace";
  return "attachment";
}

/**
 * Upload Playwright attachments to GCS and return a map of
 * normalized key → gs:// URI plus a count of RawArtifact rows written.
 *
 * In dry-run mode the upload is skipped and local paths are returned
 * unchanged for visual inspection.
 *
 * Path resolution order:
 *   1. att.path as-is (works when ingest runs on the same machine as the test)
 *   2. artifactsDir / parent-basename / filename  (preserves Playwright's
 *      per-test subdirectory structure after a drop-zone download)
 *   3. artifactsDir / filename  (flat fallback)
 *
 * Keys are lower-cased attachment names (spaces → _).
 * Only includes attachments that have a file path.
 */
async function uploadAndBuildArtifactLinks(
  attachments: PWAttachment[],
  executionId: string,
  buildId: string,
  dryRun: boolean,
  artifactsDir?: string,
): Promise<{ links: Record<string, string>; rawCount: number } | null> {
  const map: Record<string, string> = {};
  let rawCount = 0;

  for (const att of attachments) {
    if (!att.path) continue;

    // ── Resolve local path ──────────────────────────────────────────────────
    let localPath = att.path;
    if (!fs.existsSync(localPath)) {
      if (artifactsDir) {
        // Try: artifactsDir/{test-subdir}/{filename} — preserves per-test dirs
        const parentBasename = path.basename(path.dirname(att.path));
        const subdirPath = path.join(
          artifactsDir,
          parentBasename,
          path.basename(att.path),
        );
        if (fs.existsSync(subdirPath)) {
          localPath = subdirPath;
        } else {
          // Flat fallback: artifactsDir/{filename}
          const flatPath = path.join(artifactsDir, path.basename(att.path));
          if (fs.existsSync(flatPath)) {
            localPath = flatPath;
          } else {
            console.warn(
              `[storage] Attachment not found, skipping: ${path.basename(att.path)}`,
            );
            continue;
          }
        }
      } else {
        console.warn(`[storage] Attachment not found, skipping: ${att.path}`);
        continue;
      }
    }

    const normalKey = att.name.toLowerCase().replace(/\s+/g, "_");

    if (dryRun) {
      map[normalKey] = localPath;
      continue;
    }

    const gcsKey = buildKey(
      buildId,
      `attachments/${executionId}`,
      path.basename(localPath),
    );
    const { gcsUri, bytes } = await uploadFile(localPath, gcsKey);
    map[normalKey] = gcsUri;

    // ── Write RawArtifact row so the lifecycle dashboard can track it ───────
    await prisma.rawArtifact.create({
      data: {
        buildId,
        artifactType: inferArtifactType(att.contentType, att.name),
        storageUri: gcsUri,
        bytes,
      },
    });
    rawCount++;
  }

  const hasEntries = Object.keys(map).length > 0;
  return hasEntries ? { links: map, rawCount } : null;
}

/**
 * Concatenate Playwright stdout or stderr chunks into a single Buffer.
 * Returns null if the array is empty or all chunks are empty.
 */
function concatOutput(
  chunks: Array<{ text?: string; buffer?: string }>,
): Buffer | null {
  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    if (chunk.text) parts.push(Buffer.from(chunk.text, "utf-8"));
    if (chunk.buffer) parts.push(Buffer.from(chunk.buffer, "base64"));
  }
  if (parts.length === 0) return null;
  const combined = Buffer.concat(parts);
  return combined.length > 0 ? combined : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("ingest-playwright")
    .usage(
      "$0 --json-path <file> --job <jobName> --build <n> [options]\n\n" +
        "Ingest a Playwright JSON reporter file into the test-intel database.",
    )
    .option("json-path", {
      type: "string",
      demandOption: true,
      describe: "Path to Playwright JSON reporter output",
    })
    .option("job", {
      type: "string",
      demandOption: true,
      describe: "CI job full name",
    })
    .option("build", {
      type: "number",
      demandOption: true,
      describe: "Build number",
    })
    .option("ci", {
      type: "string",
      default: "jenkins",
      describe: "CI provider",
    })
    .option("build-url", { type: "string" })
    .option("git-sha", { type: "string" })
    .option("branch", { type: "string" })
    .option("environment", { type: "string" })
    .option("pr-number", { type: "string" })
    .option("shard-index", {
      type: "number",
      describe: "0-based shard index (omit if not sharding)",
    })
    .option("shard-total", { type: "number", describe: "Total shard count" })
    .option("project", {
      type: "string",
      describe: "Filter to a single Playwright project name",
    })
    .option("skip-jira-links", {
      type: "boolean",
      default: false,
      describe: "Skip writing jira_automation_link rows from @tags",
    })
    .option("skip-tr-links", {
      type: "boolean",
      default: false,
      describe: "Skip writing automation_testrail_link rows from @C1234 tags",
    })
    .option("skip-artifacts", {
      type: "boolean",
      default: false,
      describe: "Skip uploading screenshots/traces/videos to GCS",
    })
    .option("artifacts-dir", {
      type: "string",
      describe:
        "Base directory for resolving attachment paths (used when ingesting via drop zone — embedded paths are CI-machine absolute paths that do not exist locally)",
    })
    .option("extra-env", {
      type: "string",
      describe:
        "JSON string of system-level metadata to merge into CiRun.env (e.g. node version, OS, Playwright version, base URL)",
    })
    .option("dry-run", {
      type: "boolean",
      default: false,
      describe: "Parse and validate; do not write to DB",
    })
    .option("explain", {
      type: "boolean",
      default: false,
      describe: "Verbose per-test output",
    })
    .help()
    .parse();

  const args = IngestArgsSchema.parse({
    jsonPath: argv["json-path"],
    ciProvider: argv["ci"],
    jobName: argv["job"],
    buildNumber: argv["build"],
    buildUrl: argv["build-url"],
    gitSha: argv["git-sha"],
    branch: argv["branch"],
    environment: argv["environment"],
    prNumber: argv["pr-number"],
    shardIndex: argv["shard-index"],
    shardTotal: argv["shard-total"],
    projectFilter: argv["project"],
    skipJiraLinks: argv["skip-jira-links"],
    skipTrLinks: argv["skip-tr-links"],
    skipArtifacts: argv["skip-artifacts"],
    artifactsDir: argv["artifacts-dir"] as string | undefined,
    extraEnv: argv["extra-env"] as string | undefined,
    dryRun: argv["dry-run"],
    explain: argv["explain"],
  });

  // ── Read + parse JSON ───────────────────────────────────────────────────────

  const absPath = path.resolve(args.jsonPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Playwright JSON file not found: ${absPath}`);
  }

  const buf = fs.readFileSync(absPath);
  const fileSha = sha256Buf(buf);
  const report = JSON.parse(buf.toString("utf-8")) as PWReport;

  if (!report.stats || !Array.isArray(report.suites)) {
    throw new Error(
      "File does not look like a Playwright JSON reporter output. " +
        "Run tests with: npx playwright test --reporter=json",
    );
  }

  const { stats } = report;
  const startedAt = new Date(stats.startTime);
  const finishedAt = new Date(startedAt.getTime() + stats.duration);
  const runStatus = ciRunStatus(stats);

  if (args.explain) {
    console.log(
      `[explain] jsonPath=${absPath}  sha256=${fileSha.slice(0, 12)}…`,
    );
    console.log(
      `[explain] stats: expected=${stats.expected} skipped=${stats.skipped}` +
        ` unexpected=${stats.unexpected} flaky=${stats.flaky}` +
        ` duration=${stats.duration}ms → runStatus=${runStatus}`,
    );
  }

  // ── Collect test items ──────────────────────────────────────────────────────

  const collected = walkSuites(report.suites, [], "");

  interface WorkItem {
    cs: CollectedSpec;
    test: PWTest;
    testId: string; // stable ID: filePath::describe > ... > title
    titlePath: string[]; // [describe1, ..., testTitle]
  }

  const workItems: WorkItem[] = [];
  for (const cs of collected) {
    for (const test of cs.spec.tests) {
      if (args.projectFilter && test.projectName !== args.projectFilter)
        continue;
      const titlePath = [...cs.describePath, cs.spec.title];
      const testId = `${cs.filePath}::${titlePath.join(" > ")}`;
      workItems.push({ cs, test, testId, titlePath });
    }
  }

  if (args.explain) {
    console.log(`[explain] suites found: ${report.suites.length}`);
    console.log(`[explain] specs collected: ${collected.length}`);
    console.log(`[explain] work items (test×project): ${workItems.length}`);
    if (!args.skipJiraLinks) {
      const tagLinkCount = collected.reduce(
        (s, cs) => s + extractJiraKeysFromTags(cs.spec.tags).length,
        0,
      );
      console.log(`[explain] Jira keys found in spec tags: ${tagLinkCount}`);
    } else {
      console.log(
        "[explain] Jira link extraction disabled (--skip-jira-links)",
      );
    }
  }

  // ── Dry-run exit ────────────────────────────────────────────────────────────

  if (args.dryRun) {
    const totalAttempts = workItems.reduce(
      (s, w) => s + w.test.results.length,
      0,
    );
    console.log("[dry-run] Playwright JSON parsed successfully.");
    console.log(
      `[dry-run] job=${args.jobName} #${args.buildNumber} ci=${args.ciProvider}`,
    );
    console.log(
      `[dry-run] runStatus=${runStatus}  startedAt=${startedAt.toISOString()}`,
    );
    console.log(
      `[dry-run] testExecutions=${workItems.length}  totalAttempts=${totalAttempts}`,
    );
    if (!args.skipJiraLinks) {
      // Deduplicate by specId so we show per-spec, not per-project (tags are on the spec)
      const seen = new Set<string>();
      const tagLinks: string[] = [];
      for (const w of workItems) {
        if (seen.has(w.cs.spec.id)) continue;
        seen.add(w.cs.spec.id);
        for (const { issueKey, tagValue } of extractJiraKeysFromTags(
          w.cs.spec.tags,
        )) {
          tagLinks.push(`  ${w.testId} → ${issueKey}  (tag: "${tagValue}")`);
        }
      }
      if (tagLinks.length > 0) {
        console.log(
          `[dry-run] jiraLinks that would be written (${tagLinks.length}):`,
        );
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
            `${w.testId}  (${a} attempt${a !== 1 ? "s" : ""})`,
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
        ciProvider: args.ciProvider,
        jobName: args.jobName,
        buildNumber: args.buildNumber,
      },
    },
    create: {
      ciProvider: args.ciProvider,
      jobName: args.jobName,
      buildNumber: args.buildNumber,
      buildUrl: args.buildUrl,
      gitSha: args.gitSha,
      branch: args.branch,
      environment: args.environment,
      startedAt,
      finishedAt,
    },
    update: {
      buildUrl: args.buildUrl ?? undefined,
      gitSha: args.gitSha ?? undefined,
      branch: args.branch ?? undefined,
      environment: args.environment ?? undefined,
    },
  });

  // 2. Upload source JSON to GCS then record the artifact with its permanent gs:// URI.
  // Upload happens before the DB write so we never store a URI that doesn't exist.
  const jsonGcsKey = buildKey(
    build.id,
    "source/playwright-json",
    path.basename(absPath),
  );
  const { gcsUri: jsonGcsUri } = await uploadFile(absPath, jsonGcsKey);

  await prisma.rawArtifact.create({
    data: {
      buildId: build.id,
      artifactType: "playwright-json",
      storageUri: jsonGcsUri,
      sha256: fileSha,
      bytes: buf.length,
    },
  });

  // 3. Create CiRun (one per invocation — each shard is its own run)
  const ciRun = await prisma.ciRun.create({
    data: {
      buildId: build.id,
      branch: args.branch ?? null,
      gitSha: args.gitSha ?? null,
      jobName: args.jobName,
      buildNumber: args.buildNumber,
      prNumber: args.prNumber ?? null,
      startedAt,
      finishedAt,
      status: runStatus,
      project: args.projectFilter ?? null,
      shardIndex: args.shardIndex ?? null,
      shardTotal: args.shardTotal ?? null,
      env: (() => {
        const base: Record<string, unknown> = {};
        if (args.environment) base.environment = args.environment;
        if (args.extraEnv) {
          try {
            Object.assign(base, JSON.parse(args.extraEnv));
          } catch {
            /* ignore invalid JSON */
          }
        }
        return Object.keys(base).length > 0 ? base : undefined;
      })(),
    },
  });

  if (args.explain) {
    console.log(`[explain] CiRun id=${ciRun.id}`);
  }

  // 4. Pre-load known Jira issue keys for FK safety (only if link writing is on)
  const knownJiraKeys: Set<string> = args.skipJiraLinks
    ? new Set()
    : new Set(
        (await prisma.jiraIssue.findMany({ select: { issueKey: true } })).map(
          (r) => r.issueKey,
        ),
      );

  if (args.explain && !args.skipJiraLinks) {
    console.log(
      `[explain] ${knownJiraKeys.size} Jira issue keys loaded for link filtering`,
    );
  }

  // 4b. Pre-load known TestRail case IDs for FK safety
  const knownTrCaseIds: Set<bigint> = args.skipTrLinks
    ? new Set()
    : new Set(
        (
          await prisma.testRailCase.findMany({ select: { trCaseId: true } })
        ).map((r) => r.trCaseId),
      );

  if (args.explain && !args.skipTrLinks) {
    console.log(
      `[explain] ${knownTrCaseIds.size} TestRail case IDs loaded for link filtering`,
    );
  }

  // 5. Upsert TestExecutions + create TestAttempts + write Jira + TestRail links
  let executionsCreated = 0;
  let executionsUpdated = 0;
  let attemptsWritten = 0;
  let linksWritten = 0;
  let linksSkipped = 0; // key found in tag but not in jira_issue
  let trLinksWritten = 0;
  let trLinksSkipped = 0; // case ID found in tag but not in testrail_case
  let rawArtifactsWritten = 0; // screenshot/trace/video RawArtifact rows

  for (const { cs, test, testId, titlePath } of workItems) {
    const execStatus = toExecutionStatus(test.status);
    const totalDurMs = test.results.reduce((s, r) => s + r.duration, 0);
    const lastResult = test.results.at(-1);
    const failureMsg = lastResult?.errors[0]?.message?.slice(0, 2000) ?? null;

    // Collect test.info().annotations from all result attempts.
    // These carry structured metadata (AC IDs, TestRail case IDs, Jira keys)
    // authored in spec files per the section 9.8 convention:
    //   test.info().annotations.push({ type: 'TestRail', value: 'C1234' });
    //   test.info().annotations.push({ type: 'AC',       value: 'AC-04' });
    //   test.info().annotations.push({ type: 'Jira',     value: 'EVT-123' });
    // Stored in TestExecution.artifactLinks under the key "annotations" so
    // push-testrail-results.ts can resolve case IDs without re-parsing tags.
    const allAnnotations = test.results.flatMap((r) => r.annotations ?? []);
    const uniqueAnnotations = allAnnotations.filter(
      (a, i, arr) =>
        arr.findIndex(
          (b) => b.type === a.type && b.description === a.description,
        ) === i,
    );

    // Optional link to TestCase (best-effort; null if not found)
    const tcRow = await prisma.testCase.findFirst({
      where: { identityKey: testId },
      select: { id: true },
    });

    // Upsert TestExecution via findFirst+create/update to handle nullable
    // (project, shardIndex) in the unique constraint without PG NULL quirks.
    // artifactLinks is intentionally omitted here — we need execution.id first
    // to build GCS keys, then patch the record after uploading attachments.
    const existing = await prisma.testExecution.findFirst({
      where: {
        runId: ciRun.id,
        testId,
        project: test.projectName,
        shardIndex: args.shardIndex ?? null,
      },
      select: { id: true },
    });

    let execution: { id: string };

    if (existing) {
      execution = await prisma.testExecution.update({
        where: { id: existing.id },
        data: {
          status: execStatus,
          durationMs: totalDurMs,
          failureMsg,
          testCaseId: tcRow?.id ?? undefined,
        },
        select: { id: true },
      });
      executionsUpdated++;
    } else {
      execution = await prisma.testExecution.create({
        data: {
          runId: ciRun.id,
          testCaseId: tcRow?.id ?? null,
          testId,
          filePath: cs.filePath || null,
          titlePath,
          tags: cs.spec.tags ?? [],
          project: test.projectName,
          shardIndex: args.shardIndex ?? null,
          status: execStatus,
          durationMs: totalDurMs,
          failureMsg,
        },
        select: { id: true },
      });
      executionsCreated++;
    }

    // Upload attachments (screenshots, videos, traces) to GCS.
    // Only for failures and flaky tests — passing tests rarely have attachments
    // and uploading them wastes storage quota.  Use --skip-artifacts to disable.
    const shouldUploadArtifacts =
      !args.skipArtifacts &&
      lastResult &&
      lastResult.attachments.length > 0 &&
      (execStatus === "FAILED" ||
        execStatus === "FLAKY" ||
        execStatus === "ERROR");

    // Persist annotations into artifactLinks JSON now that we have execution.id.
    // Always written (even without artifact uploads) so push-testrail-results.ts
    // can resolve TestRail/AC/Jira IDs without touching the link tables.
    if (uniqueAnnotations.length > 0 && !args.dryRun) {
      await prisma.testExecution.update({
        where: { id: execution.id },
        data: { artifactLinks: { annotations: uniqueAnnotations } },
      });
    }

    if (shouldUploadArtifacts && lastResult) {
      const uploaded = await uploadAndBuildArtifactLinks(
        lastResult.attachments,
        execution.id,
        build.id,
        args.dryRun,
        args.artifactsDir,
      );
      if (uploaded) {
        // Merge file links with annotations already written above.
        await prisma.testExecution.update({
          where: { id: execution.id },
          data: {
            artifactLinks: {
              ...(uniqueAnnotations.length > 0
                ? { annotations: uniqueAnnotations }
                : {}),
              ...uploaded.links,
            },
          },
        });
        rawArtifactsWritten += uploaded.rawCount;
      }
    }

    // Upsert TestAttempts (@@unique([executionId, attemptNo]) — no nullable fields)
    for (const [i, result] of test.results.entries()) {
      const attemptNo = typeof result.retry === "number" ? result.retry : i;
      const errHash = hashFirstError(result.errors);
      const attStart = new Date(result.startTime);
      const attEnd = new Date(attStart.getTime() + result.duration);

      const attempt = await prisma.testAttempt.upsert({
        where: {
          executionId_attemptNo: {
            executionId: execution.id,
            attemptNo,
          },
        },
        create: {
          executionId: execution.id,
          attemptNo,
          status: toAttemptStatus(result.status),
          durationMs: result.duration,
          errorHash: errHash,
          startedAt: attStart,
          finishedAt: attEnd,
        },
        update: {
          status: toAttemptStatus(result.status),
          durationMs: result.duration,
          errorHash: errHash,
        },
        select: { id: true },
      });
      attemptsWritten++;

      // Persist stdout and stderr to GCS + BuildLog rows.
      // Skipped in dry-run mode; skipped when output is empty.
      if (!args.dryRun) {
        for (const [logType, chunks] of [
          ["stdout", result.stdout] as const,
          ["stderr", result.stderr] as const,
        ]) {
          const logBuf = concatOutput(chunks);
          if (!logBuf) continue;

          const gcsKey = buildKey(
            build.id,
            `attachments/${execution.id}`,
            `${logType}-attempt${attemptNo}.txt`,
          );
          const gcsUri = await uploadBuffer(logBuf, gcsKey);

          await prisma.buildLog.create({
            data: {
              attemptId: attempt.id,
              logType,
              storageUri: gcsUri,
              bytes: logBuf.length,
            },
          });

          // Fast-path URI on TestAttempt — set from stdout for quick lookup.
          if (logType === "stdout") {
            await prisma.testAttempt.update({
              where: { id: attempt.id },
              data: { logUri: gcsUri },
            });
          }
        }
      }
    }

    // ── Jira link extraction from spec @tags ────────────────────────────────
    // Only process once per spec (tags are per-spec, not per-project).
    // We track which specs we've already processed via the spec id.
    if (!args.skipJiraLinks) {
      const tagMatches = extractJiraKeysFromTags(cs.spec.tags);

      if (tagMatches.length > 0) {
        // Ensure a TestCase row exists — auto-create if the spec wasn't previously seen.
        const tcForLink = await prisma.testCase.upsert({
          where: { identityKey: testId },
          update: {},
          create: {
            identityKey: testId,
            title: cs.spec.title,
            suiteName: cs.filePath || null,
            filePath: cs.filePath || null,
          },
        });

        // Also back-fill testCaseId on the execution if it was null.
        if (!tcRow) {
          await prisma.testExecution.update({
            where: { id: execution.id },
            data: { testCaseId: tcForLink.id },
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
              evidence: `Playwright tag "${tagValue}"`,
              source: "playwright-tags",
            },
            update: {
              confidence: "HIGH",
              evidence: `Playwright tag "${tagValue}"`,
            },
          });

          if (args.explain) {
            console.log(
              `    LINK ${testId} → ${issueKey}  (tag: "${tagValue}")`,
            );
          }
          linksWritten++;
        }
      }
    }

    // ── TestRail explicit link extraction from @C1234 tags ──────────────────
    if (!args.skipTrLinks) {
      const trTagMatches = extractTrCaseIdsFromTags(cs.spec.tags);

      if (trTagMatches.length > 0) {
        // Ensure a TestCase row exists (same pattern as Jira link above)
        const tcForTrLink = await prisma.testCase.upsert({
          where: { identityKey: testId },
          update: {},
          create: {
            identityKey: testId,
            title: cs.spec.title,
            suiteName: cs.filePath || null,
            filePath: cs.filePath || null,
          },
        });

        for (const { trCaseId, tagValue } of trTagMatches) {
          if (!knownTrCaseIds.has(trCaseId)) {
            if (args.explain) {
              console.log(
                `    SKIP TR link C${trCaseId} (not in testrail_case)`,
              );
            }
            trLinksSkipped++;
            continue;
          }

          await prisma.automationTestRailLink.upsert({
            where: {
              testCaseId_trCaseId_provenance: {
                testCaseId: tcForTrLink.id,
                trCaseId,
                provenance: "EXPLICIT",
              },
            },
            create: {
              testCaseId: tcForTrLink.id,
              trCaseId,
              provenance: "EXPLICIT",
              confidence: "HIGH",
              evidence: `Playwright tag "${tagValue}"`,
              source: "testrail-tag",
            },
            update: {
              confidence: "HIGH",
              evidence: `Playwright tag "${tagValue}"`,
            },
          });

          if (args.explain) {
            console.log(
              `    TR LINK ${testId} → C${trCaseId}  (tag: "${tagValue}")`,
            );
          }
          trLinksWritten++;
        }
      }
    }

    if (args.explain) {
      const a = test.results.length;
      console.log(
        `  [${test.status.padEnd(10)}] ${test.projectName.padEnd(12)} ` +
          `${testId}  (${a} attempt${a !== 1 ? "s" : ""})`,
      );
    }
  }

  const linkSummary = args.skipJiraLinks
    ? ""
    : `  jiraLinksWritten=${linksWritten} jiraLinksSkipped=${linksSkipped}`;

  const trLinkSummary = args.skipTrLinks
    ? ""
    : `  trLinksWritten=${trLinksWritten} trLinksSkipped=${trLinksSkipped}`;

  const artifactSummary = args.skipArtifacts
    ? ""
    : `  rawArtifactsWritten=${rawArtifactsWritten}`;

  console.log(
    `Playwright ingest complete:` +
      `  job=${args.jobName} #${args.buildNumber}` +
      `  ciRunId=${ciRun.id}` +
      `  executionsCreated=${executionsCreated}` +
      `  executionsUpdated=${executionsUpdated}` +
      `  attemptsWritten=${attemptsWritten}` +
      linkSummary +
      trLinkSummary +
      artifactSummary +
      `  runStatus=${runStatus}`,
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
