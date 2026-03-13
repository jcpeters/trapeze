#!/usr/bin/env node
/**
 * setup-metabase.ts
 *
 * Idempotently wires up Metabase from scratch using its REST API:
 *   1. Waits for Metabase to be healthy
 *   2. Bootstraps the admin user if this is a first run
 *   3. Authenticates
 *   4. Creates / finds the Postgres database connection
 *   5. Creates / finds all question (card) definitions
 *   6. Creates / finds three dashboards and sets their card layouts
 *
 * Usage
 *   npm run mb:setup                  # idempotent upsert
 *   npm run mb:setup -- --reset       # delete matching dashboards/cards and recreate
 *   npm run mb:setup -- --dry-run     # print what would be created, no writes
 */

import "dotenv/config";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = yargs(hideBin(process.argv))
  .option("reset",   { type: "boolean", default: false, describe: "Delete and recreate all managed dashboards/cards" })
  .option("dry-run", { type: "boolean", default: false, describe: "Print planned actions without making API calls" })
  .parseSync();

const DRY_RUN = args["dry-run"] as boolean;
const RESET   = args.reset as boolean;

// ── Config ────────────────────────────────────────────────────────────────────
const MB_URL   = (process.env.METABASE_URL   ?? "http://localhost:3000").replace(/\/$/, "");
const MB_EMAIL = process.env.METABASE_ADMIN_EMAIL    ?? "admin@test-intel.local";
const MB_PASS  = process.env.METABASE_ADMIN_PASSWORD ?? "TestIntel1!";
const MB_SITE  = process.env.METABASE_SITE_NAME      ?? "Test Intelligence";

// Postgres connection details for the Metabase database entry
const PG_HOST = process.env.MB_PG_HOST ?? "postgres";
const PG_PORT = Number(process.env.MB_PG_PORT ?? 5432);
const PG_DB   = process.env.MB_PG_DB   ?? "test_intel";
const PG_USER = process.env.MB_PG_USER ?? "test_intel";
const PG_PASS = process.env.MB_PG_PASS ?? "test_intel";

const DB_DISPLAY_NAME = "Test Intelligence DB";

// ── Metabase API client ───────────────────────────────────────────────────────
let sessionToken = "";

async function mbFetch<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${MB_URL}/api${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sessionToken) headers["X-Metabase-Session"] = sessionToken;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Metabase API ${method} ${path} → ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

const mb = {
  get:    <T>(path: string)                => mbFetch<T>("GET",    path),
  post:   <T>(path: string, body: unknown) => mbFetch<T>("POST",   path, body),
  put:    <T>(path: string, body: unknown) => mbFetch<T>("PUT",    path, body),
  delete: (path: string)                   => mbFetch<void>("DELETE", path),
};

// ── Step 1: Wait for Metabase to be ready ─────────────────────────────────────
async function waitForMetabase(maxWaitMs = 120_000): Promise<void> {
  const start = Date.now();
  process.stdout.write("[1/7] Waiting for Metabase to be ready");
  while (true) {
    try {
      const res = await fetch(`${MB_URL}/api/health`);
      if (res.ok) { process.stdout.write(" ✓\n"); return; }
    } catch { /* not up yet */ }
    if (Date.now() - start > maxWaitMs) throw new Error("Metabase did not become healthy in time");
    process.stdout.write(".");
    await new Promise(r => setTimeout(r, 2000));
  }
}

// ── Step 2: Bootstrap admin on first run ──────────────────────────────────────
async function bootstrapIfNeeded(): Promise<void> {
  const props = await mb.get<{ "setup-token"?: string }>("/session/properties");
  const setupToken = props["setup-token"];

  if (!setupToken) {
    console.log("[2/7] Metabase already set up — skipping bootstrap");
    return;
  }

  console.log("[2/7] First run — bootstrapping admin user…");
  if (DRY_RUN) { console.log("      [dry-run] would POST /api/setup"); return; }

  try {
    await mb.post("/setup", {
      token: setupToken,
      user: {
        first_name: "Admin",
        last_name:  "User",
        email:      MB_EMAIL,
        password:   MB_PASS,
        site_name:  MB_SITE,
      },
      prefs: { site_name: MB_SITE, allow_tracking: false },
      database: null,
    });
    console.log("      ✓ Admin created");
  } catch (e: unknown) {
    // 403 = a user already exists (setup-token present but stale); safe to continue
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("403")) {
      console.log("      ✓ Admin already exists — skipping bootstrap");
    } else {
      throw e;
    }
  }
}

// ── Step 3: Authenticate ──────────────────────────────────────────────────────
async function authenticate(): Promise<void> {
  console.log("[3/7] Authenticating…");
  if (DRY_RUN) { console.log("      [dry-run] would POST /api/session"); return; }
  const res = await mb.post<{ id: string }>("/session", { username: MB_EMAIL, password: MB_PASS });
  sessionToken = res.id;
  console.log(`      ✓ Session token obtained`);
}

// ── Step 4: Upsert database connection ────────────────────────────────────────
async function upsertDatabase(): Promise<number> {
  console.log("[4/7] Upserting database connection…");
  if (DRY_RUN) { console.log(`      [dry-run] would create/find '${DB_DISPLAY_NAME}'`); return -1; }

  const { data: existing } = await mb.get<{ data: Array<{ id: number; name: string }> }>("/database");
  const found = existing.find(d => d.name === DB_DISPLAY_NAME);
  if (found) {
    console.log(`      ✓ Found existing DB id=${found.id}`);
    return found.id;
  }

  const created = await mb.post<{ id: number }>("/database", {
    name:    DB_DISPLAY_NAME,
    engine:  "postgres",
    details: {
      host:     PG_HOST,
      port:     PG_PORT,
      dbname:   PG_DB,
      user:     PG_USER,
      password: PG_PASS,
      ssl:      false,
    },
  });
  console.log(`      ✓ Created DB id=${created.id} (Metabase will sync schema automatically)`);
  return created.id;
}

// ── Card/question definitions ─────────────────────────────────────────────────
interface CardDef {
  name:        string;
  display:     "scalar" | "bar" | "line" | "table";
  query:       string;
  vizSettings: Record<string, unknown>;
}

function makeCards(_dbId: number): CardDef[] {
  return [
    // ── Coverage Overview ──────────────────────────────────────────────────
    {
      name: "[TI] Auto-tested (30d) %",
      display: "scalar",
      query: "SELECT ROUND(auto_executed_30d_pct::numeric, 1) AS \"Auto-tested (30d) %\" FROM v_executed_coverage_summary",
      vizSettings: { "scalar.field": "Auto-tested (30d) %" },
    },
    {
      name: "[TI] Manual-tested (30d) %",
      display: "scalar",
      query: "SELECT ROUND(manual_executed_30d_pct::numeric, 1) AS \"Manual-tested (30d) %\" FROM v_executed_coverage_summary",
      vizSettings: { "scalar.field": "Manual-tested (30d) %" },
    },
    {
      name: "[TI] Fully Uncovered Issues",
      display: "scalar",
      query: "SELECT fully_uncovered AS \"Fully Uncovered\" FROM v_executed_coverage_summary",
      vizSettings: { "scalar.field": "Fully Uncovered" },
    },
    {
      name: "[TI] Linked but Stale (30d)",
      display: "scalar",
      query: "SELECT linked_but_stale_30d AS \"Linked but Stale\" FROM v_executed_coverage_summary",
      vizSettings: { "scalar.field": "Linked but Stale" },
    },
    {
      name: "[TI] Coverage Trend",
      display: "line",
      query: `SELECT taken_at AS "Date",
       auto_executed_30d_pct  AS "Auto-tested %",
       manual_executed_30d_pct AS "Manual-tested %"
FROM coverage_snapshot
ORDER BY taken_at`,
      vizSettings: {
        "graph.dimensions": ["Date"],
        "graph.metrics":    ["Auto-tested %", "Manual-tested %"],
        "graph.x_axis.title_text": "Date",
        "graph.y_axis.title_text": "Coverage %",
      },
    },
    {
      name: "[TI] Coverage by Project",
      display: "bar",
      query: `SELECT project_key AS "Project",
       auto_pct      AS "Auto %",
       manual_pct    AS "Manual %",
       combined_pct  AS "Combined %"
FROM v_coverage_by_project
ORDER BY combined_pct ASC
LIMIT 20`,
      vizSettings: {
        "graph.dimensions": ["Project"],
        "graph.metrics":    ["Auto %", "Manual %", "Combined %"],
        "graph.x_axis.title_text": "Project",
        "graph.y_axis.title_text": "Coverage %",
      },
    },
    {
      name: "[TI] Coverage by Priority",
      display: "bar",
      query: `SELECT priority AS "Priority",
       total_issues  AS "Total",
       combined_pct  AS "Combined %",
       uncovered     AS "Uncovered"
FROM v_coverage_by_priority`,
      vizSettings: {
        "graph.dimensions": ["Priority"],
        "graph.metrics":    ["Combined %"],
        "graph.x_axis.title_text": "Priority",
        "graph.y_axis.title_text": "Coverage %",
      },
    },
    {
      name: "[TI] Uncovered Issues",
      display: "table",
      query: `SELECT issue_key    AS "Issue",
       summary       AS "Summary",
       status        AS "Status",
       priority      AS "Priority",
       project_key   AS "Project"
FROM v_coverage_matrix
WHERE NOT has_any_coverage
ORDER BY priority, issue_key`,
      vizSettings: { "table.pivot": false },
    },

    // ── Suite Health & Flakes ──────────────────────────────────────────────
    {
      name: "[TI] Avg Suite Pass Rate",
      display: "scalar",
      query: "SELECT COALESCE(ROUND(AVG(pass_rate_pct)::numeric, 1), 0) AS \"Avg Pass Rate %\" FROM v_suite_health",
      vizSettings: { "scalar.field": "Avg Pass Rate %" },
    },
    {
      name: "[TI] High-Severity Flakes",
      display: "scalar",
      query: "SELECT COUNT(*) AS \"High-Severity Flakes\" FROM v_flake_candidates WHERE flake_severity = 'HIGH'",
      vizSettings: { "scalar.field": "High-Severity Flakes" },
    },
    {
      name: "[TI] Suites Below 80% Pass Rate",
      display: "scalar",
      query: "SELECT COUNT(*) AS \"Suites < 80%\" FROM v_suite_health WHERE pass_rate_pct < 80",
      vizSettings: { "scalar.field": "Suites < 80%" },
    },
    {
      name: "[TI] Suite Health",
      display: "table",
      query: `SELECT suite_name              AS "Suite",
       test_case_count           AS "Tests",
       ROUND(pass_rate_pct::numeric, 1)   AS "Pass %",
       ROUND(avg_pass_duration_sec::numeric, 2) AS "Avg Duration (s)",
       last_run_at               AS "Last Run"
FROM v_suite_health
ORDER BY pass_rate_pct ASC`,
      vizSettings: { "table.pivot": false },
    },
    {
      name: "[TI] Flake Candidates",
      display: "table",
      query: `SELECT title                               AS "Test",
       "suiteName"                         AS "Suite",
       ROUND(flake_rate_pct::numeric, 1)   AS "Flake %",
       flake_severity                      AS "Severity",
       total_runs                          AS "Runs",
       linked_jira_keys                    AS "Jira Keys"
FROM v_flake_candidates
ORDER BY flake_rate_pct DESC`,
      vizSettings: { "table.pivot": false },
    },

    // ── Link Governance ────────────────────────────────────────────────────
    {
      name: "[TI] Orphan Rate %",
      display: "scalar",
      query: "SELECT ROUND(orphan_rate_pct::numeric, 1) AS \"Orphan Rate %\" FROM v_orphan_summary",
      vizSettings: { "scalar.field": "Orphan Rate %" },
    },
    {
      name: "[TI] Links Needing Review",
      display: "scalar",
      query: "SELECT needs_review_count AS \"Needs Review\" FROM v_orphan_summary",
      vizSettings: { "scalar.field": "Needs Review" },
    },
    {
      name: "[TI] Reliably Linked Tests",
      display: "scalar",
      query: "SELECT reliably_linked_count AS \"Reliably Linked\" FROM v_orphan_summary",
      vizSettings: { "scalar.field": "Reliably Linked" },
    },
    {
      name: "[TI] Link Confidence Breakdown",
      display: "bar",
      query: `SELECT link_type   AS "Link Type",
       confidence   AS "Confidence",
       link_count   AS "Count"
FROM v_link_confidence_breakdown
ORDER BY link_type, confidence`,
      vizSettings: {
        "graph.dimensions": ["Link Type", "Confidence"],
        "graph.metrics":    ["Count"],
      },
    },
    {
      name: "[TI] Unreviewed Links Queue",
      display: "table",
      query: `SELECT issue_key           AS "Issue",
       jira_summary        AS "Summary",
       test_title          AS "Test",
       confidence::text    AS "Confidence",
       provenance::text    AS "Provenance",
       source              AS "Source",
       link_created_at     AS "Created"
FROM v_unreviewed_links
ORDER BY link_created_at`,
      vizSettings: { "table.pivot": false },
    },
    {
      name: "[TI] Orphan Tests",
      display: "table",
      query: `SELECT title           AS "Test",
       "suiteName"     AS "Suite",
       total_runs      AS "Total Runs",
       last_run_at     AS "Last Run",
       pass_count      AS "Pass",
       fail_count      AS "Fail"
FROM v_orphan_tests
ORDER BY last_run_at DESC NULLS LAST
LIMIT 100`,
      vizSettings: { "table.pivot": false },
    },
  ] as CardDef[];
}

// ── Step 5: Upsert questions (cards) ─────────────────────────────────────────
async function upsertCards(
  dbId: number,
  reset: boolean,
): Promise<Map<string, number>> {
  console.log("[5/7] Upserting questions (cards)…");
  const cardDefs = makeCards(dbId);

  if (DRY_RUN) {
    for (const c of cardDefs) console.log(`      [dry-run] would create card "${c.name}"`);
    return new Map(cardDefs.map((c, i) => [c.name, -(i + 1)]));
  }

  // Fetch all existing cards in our collection
  const existing = await mb.get<Array<{ id: number; name: string; archived: boolean }>>("/card?f=all");
  const existingByName = new Map(existing.filter(c => !c.archived).map(c => [c.name, c.id]));

  const nameToId = new Map<string, number>();

  for (const def of cardDefs) {
    const existingId = existingByName.get(def.name);
    if (existingId !== undefined && reset) {
      await mb.delete(`/card/${existingId}`);
      existingByName.delete(def.name);
    }

    if (existingByName.has(def.name) && !reset) {
      const id = existingByName.get(def.name)!;
      console.log(`      skip  "${def.name}" (id=${id})`);
      nameToId.set(def.name, id);
      continue;
    }

    const card = await mb.post<{ id: number }>("/card", {
      name:    def.name,
      display: def.display,
      dataset_query: {
        type:     "native",
        database: dbId,
        native:   { query: def.query },
      },
      visualization_settings: def.vizSettings,
      collection_id: null,
    });
    console.log(`      ✓ created "${def.name}" id=${card.id}`);
    nameToId.set(def.name, card.id);
  }

  return nameToId;
}

// ── Dashboard layout helpers ──────────────────────────────────────────────────
interface DashCard {
  id:      number;   // -1 for new
  card_id: number;
  row:     number;
  col:     number;
  size_x:  number;
  size_y:  number;
}

function dc(cardId: number, row: number, col: number, sx: number, sy: number): DashCard {
  return { id: -1, card_id: cardId, row, col, size_x: sx, size_y: sy };
}

// ── Dashboard definitions ─────────────────────────────────────────────────────
interface DashboardDef {
  name:        string;
  description: string;
  cardNames:   string[];
  buildLayout: (ids: number[]) => DashCard[];
}

function dashboards(): DashboardDef[] {
  return [
    {
      name:        "[TI] Coverage Overview",
      description: "Stakeholder view: auto/manual coverage KPIs, trend line, breakdown by project and priority, uncovered issues list.",
      cardNames: [
        "[TI] Auto-tested (30d) %",
        "[TI] Manual-tested (30d) %",
        "[TI] Fully Uncovered Issues",
        "[TI] Linked but Stale (30d)",
        "[TI] Coverage Trend",
        "[TI] Coverage by Project",
        "[TI] Coverage by Priority",
        "[TI] Uncovered Issues",
      ],
      buildLayout([auto30, manual30, uncovered, stale, trend, byProject, byPriority, uncovList]) {
        return [
          // Row 0: 4 scalars (col 0,6,12,18 each width=6 height=3)
          dc(auto30,    0, 0,  6, 3),
          dc(manual30,  0, 6,  6, 3),
          dc(uncovered, 0, 12, 6, 3),
          dc(stale,     0, 18, 6, 3),
          // Row 3: trend line full width
          dc(trend,     3, 0,  24, 6),
          // Row 9: two bar charts side-by-side
          dc(byProject, 9, 0,  12, 6),
          dc(byPriority,9, 12, 12, 6),
          // Row 15: uncovered issues table full width
          dc(uncovList, 15, 0, 24, 8),
        ];
      },
    },
    {
      name:        "[TI] Suite Health & Flakes",
      description: "Engineering view: pass rate, flake severity, suite-level health table, flake candidates list.",
      cardNames: [
        "[TI] Avg Suite Pass Rate",
        "[TI] High-Severity Flakes",
        "[TI] Suites Below 80% Pass Rate",
        "[TI] Suite Health",
        "[TI] Flake Candidates",
      ],
      buildLayout([avgPass, highFlakes, suitesBelow, suiteHealth, flakeCands]) {
        return [
          // Row 0: 3 scalars
          dc(avgPass,     0, 0,  8, 3),
          dc(highFlakes,  0, 8,  8, 3),
          dc(suitesBelow, 0, 16, 8, 3),
          // Row 3: two tables side-by-side
          dc(suiteHealth, 3, 0,  12, 8),
          dc(flakeCands,  3, 12, 12, 8),
        ];
      },
    },
    {
      name:        "[TI] Link Governance",
      description: "QA analyst view: orphan rate, unreviewed links queue, confidence breakdown, orphan test list.",
      cardNames: [
        "[TI] Orphan Rate %",
        "[TI] Links Needing Review",
        "[TI] Reliably Linked Tests",
        "[TI] Link Confidence Breakdown",
        "[TI] Unreviewed Links Queue",
        "[TI] Orphan Tests",
      ],
      buildLayout([orphanRate, needsReview, reliable, confBreakdown, unreviewedQ, orphanTests]) {
        return [
          // Row 0: 3 scalars
          dc(orphanRate,    0, 0,  8, 3),
          dc(needsReview,   0, 8,  8, 3),
          dc(reliable,      0, 16, 8, 3),
          // Row 3: confidence bar chart full width
          dc(confBreakdown, 3, 0,  24, 6),
          // Row 9: two tables side-by-side
          dc(unreviewedQ,   9, 0,  12, 8),
          dc(orphanTests,   9, 12, 12, 8),
        ];
      },
    },
  ];
}

// ── Step 6 & 7: Upsert dashboards and set card layouts ───────────────────────
async function upsertDashboards(
  nameToId: Map<string, number>,
  reset: boolean,
): Promise<void> {
  console.log("[6/7] Upserting dashboards…");
  const defs = dashboards();

  if (DRY_RUN) {
    for (const d of defs) {
      console.log(`      [dry-run] would create dashboard "${d.name}" with ${d.cardNames.length} cards`);
    }
    return;
  }

  const existing = await mb.get<Array<{ id: number; name: string }>>("/dashboard");
  const existingByName = new Map(existing.map(d => [d.name, d.id]));

  for (const def of defs) {
    let dashId = existingByName.get(def.name);

    if (dashId !== undefined && reset) {
      await mb.delete(`/dashboard/${dashId}`);
      dashId = undefined;
    }

    if (dashId === undefined) {
      const created = await mb.post<{ id: number }>("/dashboard", {
        name:        def.name,
        description: def.description,
        parameters:  [],
      });
      dashId = created.id;
      console.log(`      ✓ created dashboard "${def.name}" id=${dashId}`);
    } else {
      console.log(`      skip  dashboard "${def.name}" (id=${dashId})`);
    }

    // Resolve card IDs for this dashboard
    const cardIds = def.cardNames.map(n => {
      const id = nameToId.get(n);
      if (id === undefined) throw new Error(`Card not found: "${n}"`);
      return id;
    });

    // Build layout
    const dashcards = def.buildLayout(cardIds).map((dc, i) => ({
      ...dc,
      id: -(i + 1),  // negative temporary IDs for new dashcards
      parameter_mappings:     [],
      visualization_settings: {},
    }));

    // Set the layout via PUT
    await mb.put(`/dashboard/${dashId}`, { dashcards });
    console.log(`      ✓ layout set for "${def.name}" (${dashcards.length} cards)`);
  }
}

// ── Step 8: Final summary ─────────────────────────────────────────────────────
async function printSummary(): Promise<void> {
  console.log("[7/7] Done!");
  if (DRY_RUN) return;

  const defs = dashboards();
  console.log(`\nDashboards available at ${MB_URL}:`);
  const existing = await mb.get<Array<{ id: number; name: string }>>("/dashboard");
  const byName = new Map(existing.map(d => [d.name, d.id]));
  for (const d of defs) {
    const id = byName.get(d.name);
    if (id) console.log(`  ${MB_URL}/dashboard/${id} — ${d.name}`);
  }
  console.log(`\nLogin: ${MB_EMAIL} / ${MB_PASS}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Metabase setup  url=${MB_URL}  dry-run=${DRY_RUN}  reset=${RESET}\n`);

  await waitForMetabase();
  await bootstrapIfNeeded();
  await authenticate();
  const dbId    = await upsertDatabase();
  const cardMap = await upsertCards(dbId, RESET);
  await upsertDashboards(cardMap, RESET);
  await printSummary();
}

main().catch(e => { console.error(e); process.exit(1); });
