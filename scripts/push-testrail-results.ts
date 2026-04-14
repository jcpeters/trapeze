#!/usr/bin/env node
/**
 * push-testrail-results.ts
 *
 * Pushes Playwright test run results from the Trapeze DB into TestRail as a
 * TestRail Test Run with Results.  This is the write-direction counterpart to
 * sync-testrail.ts (which only reads FROM TestRail).
 *
 * ── Source of truth ───────────────────────────────────────────────────────────
 *
 * The script reads from the DB, not from the raw JSON file.  By the time this
 * script runs, ingest-playwright.ts has already populated:
 *
 *   CiRun            — one row per Playwright invocation (shard-aware)
 *   TestExecution    — one row per test × project, with final status
 *   TestCase         — stable test identity (identityKey, title, filePath)
 *   automation_testrail_link — TestCase.id → tr_case_id (EXPLICIT or INFERRED)
 *
 * For each TestExecution, the script resolves its TestCase to one or more
 * tr_case_id values via automation_testrail_link.  Only EXPLICIT and HIGH/MED
 * INFERRED links are used — LOW-confidence links are excluded to avoid
 * polluting TestRail with noisy results.
 *
 * ── TestRail objects created ──────────────────────────────────────────────────
 *
 *   POST /add_run          → one TestRail run per CiRun (or --run-name override)
 *   POST /add_results_for_cases → all results in a single batch call per run
 *   POST /close_run        → optionally closes the run after results are added
 *
 * ── Annotation-based matching (preferred) ────────────────────────────────────
 *
 * If tests use test.info().annotations with type:'TestRail' and value:'C1234',
 * those annotations are stored in TestExecution.artifactLinks (JSON) during
 * ingest and take priority over the automation_testrail_link table.
 *
 * annotation approach (from spec section 9.8):
 *   test.info().annotations.push({ type: 'TestRail', value: 'C1234' });
 *
 * ── Status mapping ────────────────────────────────────────────────────────────
 *
 *   Playwright ExecutionStatus → TestRail status_id
 *   PASSED  → 1 (Passed)
 *   FAILED  → 5 (Failed)
 *   FLAKY   → 4 (Retest)   — passed on retry; flag for human review
 *   SKIPPED → 3 (Untested) — intentionally skipped; don't mark as passed/failed
 *   ERROR   → 5 (Failed)   — infrastructure error is still a failure
 *
 * ── Idempotency ───────────────────────────────────────────────────────────────
 *
 * TestRail runs are not upserted — each invocation creates a new run.  Use
 * --dry-run to preview without writing.  The CiRun.id is embedded in the run
 * name and description so duplicates are detectable in TestRail.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *
 *   # Push the most recent CiRun for a given Jenkins job
 *   npm run etl:push:testrail -- --job playwright-acceptance --build 10
 *
 *   # Push a specific CiRun by its DB ID
 *   npm run etl:push:testrail -- --ci-run-id clxyz123
 *
 *   # Push all CiRuns created today (nightly batch)
 *   npm run etl:push:testrail -- --since 2026-04-07
 *
 *   # Preview without writing to TestRail
 *   npm run etl:push:testrail -- --job playwright-acceptance --build 10 --dry-run
 *
 *   # Override run name and close run after pushing
 *   npm run etl:push:testrail -- --ci-run-id clxyz123 \
 *     --run-name "Find a Date — Sprint 24" --close-run
 *
 * Required env vars:
 *   DATABASE_URL
 *   TESTRAIL_BASE_URL    https://yourorg.testrail.io
 *   TESTRAIL_EMAIL       service-account@yourorg.com
 *   TESTRAIL_API_TOKEN   <API key from My Settings → API Keys>
 *   TESTRAIL_PROJECT_ID  Default TestRail project ID to create runs in
 */

import "dotenv/config";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { z } from "zod";

import { prisma } from "./db/prisma.js";

// ── Environment ───────────────────────────────────────────────────────────────

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  TESTRAIL_BASE_URL: z
    .string()
    .url()
    .transform((u) => u.replace(/\/$/, "")),
  TESTRAIL_EMAIL: z.string().min(1),
  TESTRAIL_API_TOKEN: z.string().min(1),
  TESTRAIL_PROJECT_ID: z.coerce.number().int().positive().optional(),
});

type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error(
      "Missing or invalid environment variables:\n" +
        result.error.issues
          .map((i) => `  ${i.path.join(".")}: ${i.message}`)
          .join("\n"),
    );
    process.exit(1);
  }
  return result.data;
}

// ── CLI args ──────────────────────────────────────────────────────────────────

const ArgsSchema = z.object({
  ciRunId: z.string().optional(),
  job: z.string().optional(),
  build: z.coerce.number().int().nonnegative().optional(),
  since: z.coerce.date().optional(),
  projectId: z.coerce.number().int().positive().optional(),
  suiteId: z.coerce.number().int().positive().optional(),
  runName: z.string().optional(),
  closeRun: z.boolean().default(false),
  minConfidence: z.enum(["HIGH", "MED", "LOW"]).default("MED"),
  dryRun: z.boolean().default(false),
  explain: z.boolean().default(false),
});

type Args = z.infer<typeof ArgsSchema>;

async function parseArgs(): Promise<Args> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("push-testrail-results")
    .usage("$0 [--ci-run-id ID | --job JOB --build N | --since DATE] [options]")
    // ── Selecting which CiRun(s) to push ──
    .option("ci-run-id", {
      type: "string",
      describe: "Push a specific CiRun by its DB ID",
    })
    .option("job", {
      type: "string",
      describe: "Jenkins job name (used with --build to select a CiRun)",
    })
    .option("build", {
      type: "number",
      describe: "Jenkins build number (used with --job)",
    })
    .option("since", {
      type: "string",
      describe:
        "Push all CiRuns created on or after this date (ISO-8601, e.g. 2026-04-07)",
    })
    // ── TestRail targeting ──
    .option("project-id", {
      type: "number",
      describe:
        "TestRail project ID to create runs in (overrides TESTRAIL_PROJECT_ID env var)",
    })
    .option("suite-id", {
      type: "number",
      describe: "TestRail suite ID (required if project uses multiple suites)",
    })
    .option("run-name", {
      type: "string",
      describe: "Override the auto-generated TestRail run name",
    })
    .option("close-run", {
      type: "boolean",
      default: false,
      describe:
        "Close the TestRail run after adding results (makes results immutable)",
    })
    // ── Link quality threshold ──
    .option("min-confidence", {
      choices: ["HIGH", "MED", "LOW"] as const,
      default: "MED" as const,
      describe:
        "Minimum link confidence to include. " +
        "HIGH = only EXPLICIT tags. " +
        "MED = EXPLICIT + title-inferred HIGH/MED (default). " +
        "LOW = all links including noisy inferred.",
    })
    // ── Dry-run / explain ──
    .option("dry-run", {
      type: "boolean",
      default: false,
      describe: "Preview what would be pushed without writing to TestRail",
    })
    .option("explain", {
      type: "boolean",
      default: false,
      describe: "Verbose logging of every API call and DB query",
    })
    .check((a) => {
      const hasRunId = !!a["ci-run-id"];
      const hasJob = !!a.job && a.build !== undefined;
      const hasSince = !!a.since;
      if (!hasRunId && !hasJob && !hasSince) {
        throw new Error(
          "Provide one of: --ci-run-id, --job + --build, or --since",
        );
      }
      return true;
    }).argv;

  return ArgsSchema.parse({
    ciRunId: argv["ci-run-id"],
    job: argv.job,
    build: argv.build,
    since: argv.since,
    projectId: argv["project-id"],
    suiteId: argv["suite-id"],
    runName: argv["run-name"],
    closeRun: argv["close-run"],
    minConfidence: argv["min-confidence"],
    dryRun: argv["dry-run"],
    explain: argv.explain,
  });
}

// ── Status mapping ────────────────────────────────────────────────────────────

/**
 * TestRail built-in status IDs:
 *   1 = Passed   2 = Blocked   3 = Untested   4 = Retest   5 = Failed
 */
const TR_STATUS: Record<string, number> = {
  PASSED: 1,
  FAILED: 5,
  FLAKY: 4, // passed on retry — flag for human review
  SKIPPED: 3, // intentionally skipped; don't claim pass or fail
  ERROR: 5, // infrastructure error is still a failure
};

function toTrStatus(executionStatus: string): number {
  return TR_STATUS[executionStatus] ?? 5;
}

// ── TestRail API client (POST-capable extension) ──────────────────────────────

class TestRailClient {
  private readonly authHeader: string;
  private readonly apiBase: string;

  constructor(env: Env) {
    const creds = Buffer.from(
      `${env.TESTRAIL_EMAIL}:${env.TESTRAIL_API_TOKEN}`,
    ).toString("base64");
    this.authHeader = `Basic ${creds}`;
    // TestRail's routing uses "?" as part of the path — additional params use "&"
    this.apiBase = `${env.TESTRAIL_BASE_URL}/index.php?/api/v2`;
  }

  async get<T>(path: string): Promise<T> {
    const resp = await this.request("GET", path);
    return resp.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const resp = await this.request("POST", path, body);
    return resp.json() as Promise<T>;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `${this.apiBase}/${path}`;
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (resp.status === 429) {
      const wait = parseInt(resp.headers.get("Retry-After") ?? "60", 10);
      console.warn(`[warn] TestRail rate-limited — waiting ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.request(method, path, body);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "(unreadable body)");
      throw new Error(
        `TestRail API ${resp.status} ${resp.statusText} [${method} ${path}]: ${text}`,
      );
    }

    return resp;
  }
}

// ── TestRail API shapes ───────────────────────────────────────────────────────

interface TrRun {
  id: number;
  name: string;
  url: string;
}

interface TrResultPayload {
  case_id: number;
  status_id: number;
  comment?: string;
  elapsed?: string; // e.g. "1m 30s"
}

interface TrAddResultsResponse {
  // Array of created result objects — we only need confirmation it worked
  length?: number;
}

// ── DB query helpers ──────────────────────────────────────────────────────────

/** Resolve CiRun IDs from the given CLI args. */
async function resolveCiRunIds(args: Args): Promise<string[]> {
  if (args.ciRunId) return [args.ciRunId];

  if (args.job && args.build !== undefined) {
    const runs = await prisma.ciRun.findMany({
      where: {
        build: {
          jobName: args.job,
          buildNumber: args.build,
        },
      },
      select: { id: true },
    });
    if (runs.length === 0) {
      throw new Error(
        `No CiRun found for job="${args.job}" build=${args.build}. ` +
          `Run etl:ingest:playwright first.`,
      );
    }
    return runs.map((r) => r.id);
  }

  if (args.since) {
    const runs = await prisma.ciRun.findMany({
      where: { createdAt: { gte: args.since } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    if (runs.length === 0) {
      throw new Error(
        `No CiRuns found created on or after ${args.since.toISOString()}`,
      );
    }
    return runs.map((r) => r.id);
  }

  throw new Error("Could not resolve CiRun IDs — this should not happen");
}

/**
 * Confidence filter for automation_testrail_link rows.
 * MED threshold (default) accepts HIGH and MED; LOW accepts all.
 */
function meetsConfidence(
  linkConfidence: string,
  minConfidence: string,
): boolean {
  const rank: Record<string, number> = { HIGH: 3, MED: 2, LOW: 1 };
  return (rank[linkConfidence] ?? 0) >= (rank[minConfidence] ?? 0);
}

/**
 * For a CiRun, load all TestExecutions with their TestCase and resolved
 * TestRail case IDs.
 *
 * Resolution priority:
 *   1. test.info().annotations with type:'TestRail' stored in TestExecution
 *      (these are stored as { testRailCaseIds: number[] } in artifactLinks JSON)
 *   2. automation_testrail_link rows (EXPLICIT first, then INFERRED by confidence)
 *
 * Returns a flat list of { trCaseId, status, durationMs, comment } rows
 * ready to be batched into add_results_for_cases.
 */
async function buildResultPayloads(
  ciRunId: string,
  minConfidence: string,
  explain: boolean,
): Promise<{ payloads: TrResultPayload[]; skipped: number }> {
  const executions = await prisma.testExecution.findMany({
    where: { runId: ciRunId },
    include: {
      testCase: {
        include: {
          // EXPLICIT links (provenance = EXPLICIT, confidence always HIGH)
          // plus INFERRED links filtered by confidence below
          automationTestrailLinks: {
            select: { trCaseId: true, confidence: true, provenance: true },
          },
        },
      },
    },
  });

  if (explain) {
    console.log(
      `[explain] CiRun ${ciRunId}: ${executions.length} TestExecution rows`,
    );
  }

  const payloads: TrResultPayload[] = [];
  let skipped = 0;

  for (const exec of executions) {
    if (!exec.testCase) {
      if (explain)
        console.log(
          `[explain] skip: execution ${exec.id} has no linked TestCase`,
        );
      skipped++;
      continue;
    }

    // ── Priority 1: annotations stored on the execution ──────────────────────
    // ingest-playwright stores test.info().annotations as part of artifactLinks
    // as: { ..., testRailAnnotations: [{ type: "TestRail", value: "C1234" }] }
    const annotationIds = extractAnnotationCaseIds(exec.artifactLinks);

    // ── Priority 2: automation_testrail_link table ────────────────────────────
    const linkIds = (exec.testCase.automationTestrailLinks ?? [])
      .filter((l) => meetsConfidence(l.confidence, minConfidence))
      .map((l) => Number(l.trCaseId));

    // Merge: annotation IDs take precedence; link IDs fill in the rest
    const allIds = annotationIds.length > 0 ? annotationIds : linkIds;

    if (allIds.length === 0) {
      if (explain) {
        console.log(
          `[explain] skip: "${exec.testCase.title ?? exec.testId}" — no TR case IDs resolved`,
        );
      }
      skipped++;
      continue;
    }

    const comment = buildComment(exec);
    const elapsed = exec.durationMs ? msToElapsed(exec.durationMs) : undefined;

    for (const caseId of allIds) {
      payloads.push({
        case_id: caseId,
        status_id: toTrStatus(exec.status),
        comment,
        elapsed,
      });
      if (explain) {
        console.log(
          `[explain] → C${caseId} | ${exec.status} | "${exec.testCase.title ?? exec.testId}"`,
        );
      }
    }
  }

  return { payloads, skipped };
}

/**
 * Extract TestRail case IDs stored in TestExecution.artifactLinks JSON.
 * ingest-playwright stores test.info().annotations under the key
 * "testRailAnnotations" as [{ type: "TestRail", value: "C1234" }].
 */
function extractAnnotationCaseIds(artifactLinks: unknown): number[] {
  if (!artifactLinks || typeof artifactLinks !== "object") return [];
  const obj = artifactLinks as Record<string, unknown>;
  const annotations = obj["testRailAnnotations"];
  if (!Array.isArray(annotations)) return [];
  const ids: number[] = [];
  for (const a of annotations) {
    if (
      a &&
      typeof a === "object" &&
      (a as Record<string, unknown>)["type"] === "TestRail"
    ) {
      const val = (a as Record<string, unknown>)["value"];
      if (typeof val === "string") {
        // Accept "C1234" or "1234"
        const m = val.match(/[Cc]?(\d+)/);
        if (m) ids.push(parseInt(m[1], 10));
      }
    }
  }
  return ids;
}

/** Format a human-readable comment for the TestRail result. */
function buildComment(exec: {
  status: string;
  failureMsg: string | null;
  testCase: { title: string | null } | null;
  testId: string;
}): string {
  const lines: string[] = [];
  lines.push(`Playwright: ${exec.status}`);
  if (exec.failureMsg) {
    // Truncate long failure messages — TestRail comments have a practical limit
    const truncated =
      exec.failureMsg.length > 500
        ? exec.failureMsg.slice(0, 500) + "…"
        : exec.failureMsg;
    lines.push(`\nFailure:\n${truncated}`);
  }
  lines.push(`\nTest: ${exec.testCase?.title ?? exec.testId}`);
  return lines.join("");
}

/** Convert milliseconds to TestRail elapsed format: "1m 30s" */
function msToElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/** Auto-generate a TestRail run name from CiRun metadata. */
function buildRunName(
  ciRun: {
    id: string;
    jobName: string | null;
    buildNumber: number | null;
    createdAt: Date;
  },
  override?: string,
): string {
  if (override) return override;
  const job = ciRun.jobName ?? "playwright";
  const build =
    ciRun.buildNumber != null ? `#${ciRun.buildNumber}` : ciRun.id.slice(0, 8);
  const date = ciRun.createdAt.toISOString().slice(0, 10);
  return `${job} ${build} — ${date}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();
  const args = await parseArgs();

  const projectId = args.projectId ?? env.TESTRAIL_PROJECT_ID;
  if (!projectId) {
    console.error(
      "No TestRail project ID. Provide --project-id or set TESTRAIL_PROJECT_ID env var.",
    );
    process.exit(1);
  }

  const client = new TestRailClient(env);
  const ciRunIds = await resolveCiRunIds(args);

  console.log(
    `Pushing ${ciRunIds.length} CiRun(s) to TestRail project ${projectId}...`,
  );

  let totalRuns = 0;
  let totalResults = 0;
  let executionsSkipped = 0;

  for (const ciRunId of ciRunIds) {
    const ciRun = await prisma.ciRun.findUnique({
      where: { id: ciRunId },
      select: {
        id: true,
        jobName: true,
        buildNumber: true,
        branch: true,
        gitSha: true,
        status: true,
        createdAt: true,
        build: { select: { ciProvider: true } },
      },
    });

    if (!ciRun) {
      console.warn(`[warn] CiRun ${ciRunId} not found — skipping`);
      continue;
    }

    const { payloads, skipped } = await buildResultPayloads(
      ciRunId,
      args.minConfidence,
      args.explain,
    );
    executionsSkipped += skipped;

    if (payloads.length === 0) {
      console.log(
        `[skip] CiRun ${ciRunId} — no results with resolvable TestRail case IDs`,
      );
      continue;
    }

    const runName = buildRunName(ciRun, args.runName);
    const runDescription =
      `Automated Playwright run pushed by Trapeze.\n` +
      `CiRun: ${ciRun.id}\n` +
      `Job: ${ciRun.jobName ?? "(unknown)"} build ${ciRun.buildNumber ?? "?"}\n` +
      `Branch: ${ciRun.branch ?? "?"} @ ${ciRun.gitSha?.slice(0, 8) ?? "?"}\n` +
      `Overall status: ${ciRun.status}`;

    // Collect the unique case IDs so TestRail pre-populates the run with only
    // the cases we're going to report on (instead of the entire suite).
    const caseIds = [...new Set(payloads.map((p) => p.case_id))];

    if (args.dryRun) {
      console.log(`[dry-run] Would create TestRail run: "${runName}"`);
      console.log(
        `[dry-run]   project_id=${projectId} case_ids=[${caseIds.join(", ")}]`,
      );
      console.log(`[dry-run]   ${payloads.length} results to push`);
      payloads.forEach((p) =>
        console.log(
          `[dry-run]     C${p.case_id} → status_id=${p.status_id} (${elapsed(p)})`,
        ),
      );
      totalResults += payloads.length;
      continue;
    }

    // ── Step 1: Create the TestRail run ───────────────────────────────────────
    if (args.explain) {
      console.log(
        `[explain] POST add_run project_id=${projectId} name="${runName}"`,
      );
    }

    const runPayload: Record<string, unknown> = {
      name: runName,
      description: runDescription,
      case_ids: caseIds,
      include_all: false, // only include the cases we're reporting on
    };
    if (args.suiteId) runPayload["suite_id"] = args.suiteId;

    const run = await client.post<TrRun>(`add_run/${projectId}`, runPayload);

    console.log(`  ✓ Created run #${run.id} "${run.name}" — ${run.url}`);

    // ── Step 2: Push results ──────────────────────────────────────────────────
    if (args.explain) {
      console.log(
        `[explain] POST add_results_for_cases/${run.id} — ${payloads.length} results`,
      );
    }

    await client.post<TrAddResultsResponse>(`add_results_for_cases/${run.id}`, {
      results: payloads,
    });

    console.log(`  ✓ Pushed ${payloads.length} result(s) to run #${run.id}`);

    // ── Step 3: Optionally close the run ─────────────────────────────────────
    if (args.closeRun) {
      if (args.explain) console.log(`[explain] POST close_run/${run.id}`);
      await client.post(`close_run/${run.id}`, {});
      console.log(`  ✓ Closed run #${run.id}`);
    }

    totalRuns++;
    totalResults += payloads.length;
  }

  if (args.dryRun) {
    console.log(
      `\n[dry-run] Summary: ${ciRunIds.length} CiRun(s), ` +
        `${totalResults} results would be pushed, ` +
        `executions skipped (no TR case ID): ${executionsSkipped}`,
    );
  } else {
    console.log(
      `\nDone. Runs created: ${totalRuns}, results pushed: ${totalResults}, ` +
        `executions skipped (no TR case ID): ${executionsSkipped}`,
    );
  }
}

function elapsed(p: TrResultPayload): string {
  return p.elapsed ?? "?";
}

main()
  .catch((err) => {
    console.error("[fatal]", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
