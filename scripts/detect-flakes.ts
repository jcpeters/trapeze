#!/usr/bin/env node
/**
 * detect-flakes.ts
 *
 * Analyses TestExecution history in a rolling window and writes FlakeDecision
 * rows for tests that show flaky behaviour.
 *
 * Algorithm
 * ─────────
 *  1. Load all TestExecution rows in the window (status ∈ PASSED|FAILED|FLAKY|ERROR)
 *     joined with their CiRun.startedAt and their TestAttempt error hashes.
 *  2. Group by testId (aggregated across Playwright projects / shards).
 *  3. Skip groups with fewer than --min-runs total executions.
 *  4. Compute flake score:
 *       flakySignal = flakyRuns + (hasBothPassAndFail ? min(failedRuns, passedRuns) : 0)
 *       flakeScore  = flakySignal / total
 *  5. Skip tests below --min-score (default 10 %).
 *  6. Classify the flake cause from error message patterns and hash diversity:
 *       INFRA       — timeout / network / browser-crash keywords
 *       PRODUCT_BUG — consistent single-hash error pattern
 *       TEST_CODE   — multiple distinct error hashes (non-deterministic assertion)
 *       UNKNOWN     — insufficient signal
 *  7. Find-or-create a TestCase row (identityKey = testId) so we have an FK.
 *  8. Upsert FlakeDecision keyed by (testCaseId, windowStart day).
 *     Running the script twice on the same day updates; a new day creates a
 *     new historical record.
 *
 * Usage
 * ─────
 *   npm run analyze:flakes
 *   npm run analyze:flakes -- --window-days 14 --min-runs 3 --min-score 0.15
 *   npm run analyze:flakes -- --dry-run --explain
 *   npm run analyze:flakes -- --resolve   # also clear decisions for healthy tests
 */

import "dotenv/config";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { prisma } from "./db/prisma";

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_MIN_RUNS    = 5;
const DEFAULT_MIN_SCORE   = 0.10;

/** Error message fragments that strongly suggest infrastructure instability. */
const INFRA_PATTERNS: RegExp[] = [
  /timed?\s*out/i,
  /ECONNREFUSED/i, /ECONNRESET/i, /ETIMEDOUT/i, /EHOSTUNREACH/i,
  /network\s+error/i,
  /worker\s+(crashed|killed|died)/i,
  /browser\s+(closed|disconnected|crashed)/i,
  /target\s+closed/i,
  /page\s+closed/i,
  /protocol\s+error/i,
  /out\s+of\s+memory/i,
  /spawn\s+\S+\s+ENOENT/i,
];

// ── Types ─────────────────────────────────────────────────────────────────────

type ExecStatus   = "PASSED" | "FAILED" | "FLAKY" | "ERROR";
type FlakeClass   = "INFRA" | "TEST_CODE" | "PRODUCT_BUG" | "UNKNOWN";
type RecommAction = "rerun" | "assign" | "quarantine";

interface ExecRecord {
  status:      ExecStatus;
  failureMsg:  string | null;
  errorHashes: (string | null)[];
  runStart:    Date | null;
}

interface GroupStats {
  testId:  string;
  records: ExecRecord[];
  // computed
  total:   number;
  passed:  number;
  failed:  number;
  flaky:   number;
  error:   number;
  flakeScore: number;
}

interface FlakeAnalysis extends GroupStats {
  classification:    FlakeClass;
  recommendedAction: RecommAction;
  notes:             string;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

/** UTC start of a date (midnight). */
function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ── Flake scoring ─────────────────────────────────────────────────────────────

function computeScore(stats: Pick<GroupStats, "passed" | "failed" | "flaky" | "total">): number {
  const { passed, failed, flaky, total } = stats;
  if (total === 0) return 0;
  // Direct flake signal (Playwright-detected retries that eventually passed)
  let flakySignal = flaky;
  // Cross-run inconsistency: the test is both passing and failing in the window
  if (passed > 0 && failed > 0) {
    flakySignal += Math.min(failed, passed);
  }
  return flakySignal / total;
}

// ── Classification ────────────────────────────────────────────────────────────

function classify(records: ExecRecord[]): FlakeClass {
  const failureMessages = records
    .filter((r) => r.status !== "PASSED" && r.failureMsg)
    .map((r) => r.failureMsg as string);

  if (failureMessages.length === 0) return "UNKNOWN";

  // Infrastructure? More than half the failures match infra patterns.
  const infraCount = failureMessages.filter((msg) =>
    INFRA_PATTERNS.some((re) => re.test(msg))
  ).length;
  if (infraCount / failureMessages.length > 0.5) return "INFRA";

  // Collect distinct non-null error hashes from failed/flaky attempts.
  const hashes = new Set(
    records
      .flatMap((r) => r.errorHashes)
      .filter((h): h is string => h !== null)
  );

  // Single consistent error → deterministic, likely product bug.
  if (hashes.size === 1) return "PRODUCT_BUG";

  // Multiple distinct error patterns → non-determinism in test code.
  if (hashes.size > 1) return "TEST_CODE";

  return "UNKNOWN";
}

// ── Recommended action ────────────────────────────────────────────────────────

function recommendAction(flakeScore: number): RecommAction {
  if (flakeScore >= 0.50) return "quarantine"; // failing ≥ 50 % of the time
  if (flakeScore >= 0.25) return "assign";     // 25–49 % → investigate
  return "rerun";                              // < 25 % → tolerate with retry
}

// ── Notes builder ─────────────────────────────────────────────────────────────

function buildNotes(a: FlakeAnalysis): string {
  const pct = (a.flakeScore * 100).toFixed(1);
  const uniqueHashes = new Set(
    a.records.flatMap((r) => r.errorHashes).filter(Boolean)
  ).size;
  const projects = [
    ...new Set(
      a.records
        .map((_, i) => i) // placeholder — we aggregate across projects
    ),
  ].length;
  return (
    `${a.total} run(s) in window: ${a.passed} passed, ${a.failed} failed, ` +
    `${a.flaky} flaky, ${a.error} error. ` +
    `Score=${pct}% class=${a.classification} ` +
    `uniqueErrorHashes=${uniqueHashes}`
  );
}

// ── TestCase auto-creation ────────────────────────────────────────────────────

/**
 * Extract a human-readable title and suite name from a Playwright-style testId.
 * testId format: "tests/path/file.spec.ts::Describe > Nested > Test title"
 */
function parseTestId(testId: string): { title: string; suiteName: string | null; filePath: string | null } {
  const sep = testId.indexOf("::");
  if (sep === -1) return { title: testId, suiteName: null, filePath: null };

  const filePart   = testId.slice(0, sep);
  const titlePart  = testId.slice(sep + 2);
  const segments   = titlePart.split(" > ");
  const title      = segments.at(-1) ?? testId;

  return { title, suiteName: filePart, filePath: filePart };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("detect-flakes")
    .usage(
      "$0 [options]\n\n" +
      "Analyse test execution history and write FlakeDecision rows."
    )
    .option("window-days", {
      type: "number", default: DEFAULT_WINDOW_DAYS,
      describe: "Number of days of history to analyse",
    })
    .option("min-runs", {
      type: "number", default: DEFAULT_MIN_RUNS,
      describe: "Minimum executions in the window before a test can be flagged",
    })
    .option("min-score", {
      type: "number", default: DEFAULT_MIN_SCORE,
      describe: "Minimum flake score (0–1) to write a FlakeDecision",
    })
    .option("resolve", {
      type: "boolean", default: false,
      describe: "Also mark previously-flagged tests as resolved when they are now healthy",
    })
    .option("dry-run", {
      alias: "n", type: "boolean", default: false,
      describe: "Analyse and report without writing any rows",
    })
    .option("explain", {
      type: "boolean", default: false,
      describe: "Print per-test analysis detail",
    })
    .help()
    .parse();

  const windowDays = argv["window-days"] as number;
  const minRuns    = argv["min-runs"]    as number;
  const minScore   = argv["min-score"]   as number;
  const doResolve  = argv["resolve"]     as boolean;
  const dryRun     = argv["dry-run"]     as boolean;
  const explain    = argv["explain"]     as boolean;

  const windowEnd   = utcDayStart(new Date());
  const windowStart = new Date(windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000);

  if (explain) {
    console.log(
      `[explain] window: ${windowStart.toISOString().slice(0, 10)} → ` +
      `${windowEnd.toISOString().slice(0, 10)} (${windowDays} days)`
    );
    console.log(`[explain] minRuns=${minRuns}  minScore=${(minScore * 100).toFixed(0)}%`);
    if (dryRun) console.log("[explain] DRY RUN — no writes");
  }

  // ── Step 1: load executions in the window ──────────────────────────────────

  const rawExecs = await prisma.testExecution.findMany({
    where: {
      status: { in: ["PASSED", "FAILED", "FLAKY", "ERROR"] },
      run: { startedAt: { gte: windowStart, lt: windowEnd } },
    },
    select: {
      testId:     true,
      status:     true,
      failureMsg: true,
      run:        { select: { startedAt: true } },
      attempts:   { select: { status: true, errorHash: true } },
    },
    orderBy: { run: { startedAt: "asc" } },
  });

  if (explain) {
    console.log(`[explain] ${rawExecs.length} executions loaded from DB`);
  }

  if (rawExecs.length === 0) {
    console.log(
      "No executions found in the analysis window. " +
      "Run etl:ingest:playwright (or etl:ingest:junit) first, then re-run."
    );
    return;
  }

  // ── Step 2: group by testId ────────────────────────────────────────────────

  const groups = new Map<string, ExecRecord[]>();
  for (const ex of rawExecs) {
    const rec: ExecRecord = {
      status:      ex.status as ExecStatus,
      failureMsg:  ex.failureMsg,
      errorHashes: ex.attempts.map((a) => a.errorHash),
      runStart:    ex.run.startedAt,
    };
    const list = groups.get(ex.testId) ?? [];
    list.push(rec);
    groups.set(ex.testId, list);
  }

  if (explain) {
    console.log(`[explain] ${groups.size} unique testIds`);
  }

  // ── Step 3–5: score and filter ─────────────────────────────────────────────

  const analyses: FlakeAnalysis[] = [];
  const belowThreshold: string[]  = [];

  for (const [testId, records] of groups) {
    const total  = records.length;
    const passed = records.filter((r) => r.status === "PASSED").length;
    const failed = records.filter((r) => r.status === "FAILED").length;
    const flaky  = records.filter((r) => r.status === "FLAKY").length;
    const error  = records.filter((r) => r.status === "ERROR").length;

    if (total < minRuns) {
      if (explain) {
        console.log(`  SKIP  ${testId}  (${total} runs < minRuns=${minRuns})`);
      }
      continue;
    }

    const flakeScore = computeScore({ total, passed, failed, flaky });

    if (flakeScore < minScore) {
      if (explain) {
        const pct = (flakeScore * 100).toFixed(1);
        console.log(`  SKIP  ${testId}  (score=${pct}% < ${(minScore * 100).toFixed(0)}%)`);
      }
      belowThreshold.push(testId);
      continue;
    }

    const classification    = classify(records);
    const recommendedAction = recommendAction(flakeScore);
    const stats: GroupStats = { testId, records, total, passed, failed, flaky, error, flakeScore };
    const analysis: FlakeAnalysis = { ...stats, classification, recommendedAction, notes: "" };
    analysis.notes = buildNotes(analysis);

    analyses.push(analysis);

    if (explain) {
      const pct = (flakeScore * 100).toFixed(1);
      console.log(
        `  FLAG  ${testId}\n` +
        `        score=${pct}%  class=${classification}` +
        `  action=${recommendedAction}  (${total} runs: ${passed}P/${failed}F/${flaky}K/${error}E)`
      );
    }
  }

  console.log(
    `Analysis: ${groups.size} tests in window → ${analyses.length} flagged, ` +
    `${belowThreshold.length} below threshold`
  );

  if (dryRun) {
    console.log("[dry-run] No FlakeDecision rows written.");
    return;
  }

  // ── Step 6–8: write FlakeDecision rows ────────────────────────────────────

  let created = 0;
  let updated = 0;

  for (const a of analyses) {
    // 6. Find-or-create TestCase
    const { title, suiteName, filePath } = parseTestId(a.testId);
    const testCase = await prisma.testCase.upsert({
      where:  { identityKey: a.testId },
      update: {},
      create: { identityKey: a.testId, title, suiteName, filePath },
    });

    // 7. Upsert FlakeDecision keyed by (testCaseId, windowStart day)
    //    Prisma has no compound unique here, so findFirst + create/update.
    const existing = await prisma.flakeDecision.findFirst({
      where: {
        testCaseId:  testCase.id,
        windowStart: { gte: windowStart },
      },
      select: { id: true },
    });

    const payload = {
      testCaseId:        testCase.id,
      windowStart,
      windowEnd,
      flakeScore:        a.flakeScore,
      classification:    a.classification,
      recommendedAction: a.recommendedAction,
      notes:             a.notes,
    };

    if (existing) {
      await prisma.flakeDecision.update({ where: { id: existing.id }, data: payload });
      updated++;
    } else {
      await prisma.flakeDecision.create({ data: payload });
      created++;
    }

    if (explain) {
      console.log(
        `  ${existing ? "UPD" : "NEW"}  FlakeDecision for ${a.testId}` +
        ` → ${a.recommendedAction} (${(a.flakeScore * 100).toFixed(1)}%)`
      );
    }
  }

  // ── Optional: resolve decisions for now-healthy tests ─────────────────────

  let resolved = 0;
  if (doResolve && belowThreshold.length > 0) {
    // Find TestCase ids for below-threshold tests that have open FlakeDecisions
    const tcRows = await prisma.testCase.findMany({
      where:  { identityKey: { in: belowThreshold } },
      select: { id: true, identityKey: true },
    });

    if (tcRows.length > 0) {
      const tcIds = tcRows.map((r) => r.id);
      const openDecisions = await prisma.flakeDecision.findMany({
        where: {
          testCaseId:  { in: tcIds },
          approvedAt:  null, // not yet reviewed/closed
          windowStart: { gte: windowStart },
        },
        select: { id: true, testCaseId: true },
      });

      for (const d of openDecisions) {
        const tc = tcRows.find((r) => r.id === d.testCaseId);
        await prisma.flakeDecision.update({
          where: { id: d.id },
          data:  {
            notes: `[auto-resolved] Test dropped below flake threshold after ${windowDays}-day re-analysis.`,
            recommendedAction: "ignore",
          },
        });
        if (explain) {
          console.log(`  RESOLVED  ${tc?.identityKey ?? d.testCaseId}`);
        }
        resolved++;
      }
    }
  }

  console.log(
    `FlakeDecision rows: created=${created} updated=${updated}` +
    (doResolve ? ` resolved=${resolved}` : "")
  );
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
