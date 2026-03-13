#!/usr/bin/env node
/**
 * snapshot-coverage.ts
 *
 * Reads the current KPI values from v_executed_coverage_summary and inserts
 * one row into coverage_snapshot.  Run nightly (e.g. from a cron / Jenkins
 * post-step) to build the time-series dataset that Metabase uses for
 * coverage trend charts.
 *
 * Default behaviour: skip if a snapshot was already taken today (UTC calendar
 * day).  Use --force to insert a second snapshot on the same day.
 *
 * Usage:
 *   npm run etl:snapshot:coverage
 *   npm run etl:snapshot:coverage -- --dry-run
 *   npm run etl:snapshot:coverage -- --force
 *   npm run etl:snapshot:coverage -- --explain
 */

import "dotenv/config";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { prisma } from "./db/prisma";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Shape returned by `SELECT * FROM v_executed_coverage_summary`.
 *
 * Postgres raw query quirks:
 *   COUNT(*)       → BigInt   (use Number())
 *   ROUND(…, 1)    → Prisma.Decimal / string (use parseFloat(String()))
 *   NOW()::DATE    → Date object (unused here)
 */
interface SummaryRow {
  total_issues:           bigint;
  auto_executed_30d:      bigint;
  auto_executed_30d_pct:  string | null; // NUMERIC from ROUND()
  auto_executed_7d:       bigint;
  auto_executed_7d_pct:   string | null;
  linked_but_stale_30d:   bigint;
  fully_uncovered:        bigint;
  manual_executed_30d:    bigint;
  manual_executed_30d_pct: string | null;
  manual_executed_7d:     bigint;
  manual_executed_7d_pct: string | null;
  as_of_date:             Date;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** BigInt → number (safe for row counts that will never exceed 2^53). */
const toInt = (v: unknown): number => Number(v);

/** NUMERIC string / null → float.  Returns 0 when the view returns NULL
 *  (happens when total_issues = 0, i.e. the jira_issue table is empty). */
const toFloat = (v: unknown): number =>
  v == null ? 0 : parseFloat(String(v));

/** Returns a Date representing the start of the current UTC calendar day. */
function utcStartOfDay(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("snapshot-coverage")
    .usage(
      "$0 [options]\n\n" +
      "Snapshot current coverage KPIs into coverage_snapshot for trend analysis."
    )
    .option("dry-run", {
      alias: "n",
      type: "boolean",
      default: false,
      describe: "Read and display KPIs but do not write a snapshot row",
    })
    .option("force", {
      type: "boolean",
      default: false,
      describe: "Insert even if a snapshot already exists for today (UTC)",
    })
    .option("explain", {
      type: "boolean",
      default: false,
      describe: "Print the KPI values that will be recorded",
    })
    .help()
    .parse();

  const dryRun  = argv["dry-run"] as boolean;
  const force   = argv["force"]   as boolean;
  const explain = argv["explain"] as boolean;

  // ── Step 1: read current KPIs from the view ──────────────────────────────

  const rows = await prisma.$queryRaw<SummaryRow[]>`
    SELECT * FROM v_executed_coverage_summary LIMIT 1
  `;

  if (rows.length === 0) {
    console.warn(
      "v_executed_coverage_summary returned no rows — " +
      "run db:views to apply coverage views first.\nExiting."
    );
    return;
  }

  const r = rows[0];

  const kpis = {
    totalIssues:          toInt(r.total_issues),
    autoExecuted30d:      toInt(r.auto_executed_30d),
    autoExecuted30dPct:   toFloat(r.auto_executed_30d_pct),
    autoExecuted7d:       toInt(r.auto_executed_7d),
    autoExecuted7dPct:    toFloat(r.auto_executed_7d_pct),
    linkedButStale30d:    toInt(r.linked_but_stale_30d),
    fullyUncovered:       toInt(r.fully_uncovered),
    manualExecuted30d:    toInt(r.manual_executed_30d),
    manualExecuted30dPct: toFloat(r.manual_executed_30d_pct),
    manualExecuted7d:     toInt(r.manual_executed_7d),
    manualExecuted7dPct:  toFloat(r.manual_executed_7d_pct),
  };

  if (explain || dryRun) {
    console.log("Coverage KPIs as of", new Date().toISOString());
    console.log(`  totalIssues          = ${kpis.totalIssues}`);
    console.log(`  autoExecuted30d      = ${kpis.autoExecuted30d}  (${kpis.autoExecuted30dPct}%)`);
    console.log(`  autoExecuted7d       = ${kpis.autoExecuted7d}  (${kpis.autoExecuted7dPct}%)`);
    console.log(`  linkedButStale30d    = ${kpis.linkedButStale30d}`);
    console.log(`  fullyUncovered       = ${kpis.fullyUncovered}`);
    console.log(`  manualExecuted30d    = ${kpis.manualExecuted30d}  (${kpis.manualExecuted30dPct}%)`);
    console.log(`  manualExecuted7d     = ${kpis.manualExecuted7d}  (${kpis.manualExecuted7dPct}%)`);
  }

  if (dryRun) {
    console.log("\n[dry-run] No snapshot row written.");
    return;
  }

  // ── Step 2: guard against duplicate snapshots on the same calendar day ──

  if (!force) {
    const todayUtc = utcStartOfDay();
    const existing = await prisma.coverageSnapshot.findFirst({
      where:   { takenAt: { gte: todayUtc } },
      orderBy: { takenAt: "desc" },
      select:  { id: true, takenAt: true },
    });

    if (existing) {
      console.log(
        `Snapshot already taken today (${existing.takenAt.toISOString()}, id=${existing.id}).` +
        `\nUse --force to insert another.  Exiting.`
      );
      return;
    }
  }

  // ── Step 3: insert snapshot row ──────────────────────────────────────────

  const snap = await prisma.coverageSnapshot.create({ data: kpis });

  console.log(
    `Snapshot recorded: id=${snap.id}` +
    `  takenAt=${snap.takenAt.toISOString()}` +
    `  totalIssues=${snap.totalIssues}` +
    `  autoExec30d=${snap.autoExecuted30d}(${snap.autoExecuted30dPct}%)` +
    `  autoExec7d=${snap.autoExecuted7d}(${snap.autoExecuted7dPct}%)`
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
