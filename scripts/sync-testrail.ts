#!/usr/bin/env node
/**
 * sync-testrail.ts
 *
 * Two-phase TestRail sync:
 *
 *   Phase 1 — Cases
 *     Fetches all test cases from the given TestRail projects / suites and
 *     upserts them into testrail_case.  Also parses each case's `refs` field
 *     for Jira issue keys and writes jira_testrail_link rows (provenance=EXPLICIT,
 *     confidence=HIGH) for any issue key already present in jira_issue.
 *     Section names are resolved into a human-readable path (e.g. "Login / Happy Path").
 *
 *   Phase 2 — Results
 *     Fetches test runs (incremental by default: only runs created after the
 *     MAX(tested_at) watermark) and upserts each result into testrail_result.
 *     Only results whose case is already in testrail_case are stored, so case
 *     sync should be run before (or alongside) result sync.
 *
 * Usage:
 *   npm run etl:sync:testrail -- --project-ids 1 [options]
 *
 * Required env vars (see .env):
 *   TESTRAIL_BASE_URL    https://yourorg.testrail.io
 *   TESTRAIL_EMAIL       service-account@yourorg.com
 *   TESTRAIL_API_TOKEN   <API key from My Settings → API Keys>
 *
 * Optional env vars:
 *   TESTRAIL_PROJECT_IDS  Comma-separated default project IDs (overridden by --project-ids)
 *
 * TestRail URL note:
 *   TestRail uses the unusual base path /index.php?/api/v2 — the "?" is part
 *   of the route, not a query-string delimiter.  Additional query parameters
 *   are therefore appended with "&", not "?".
 */

import "dotenv/config";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { prisma } from "./db/prisma";

// Shorthand for Prisma's JSON-safe input type
type JsonValue = Prisma.InputJsonValue;

// ── Environment ───────────────────────────────────────────────────────────────

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  TESTRAIL_BASE_URL: z
    .string()
    .url()
    .transform((u) => u.replace(/\/$/, "")),
  TESTRAIL_EMAIL: z.string().min(1),
  TESTRAIL_API_TOKEN: z.string().min(1),
  TESTRAIL_PROJECT_IDS: z.string().optional(),
});

type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error(
      "Missing or invalid environment variables:\n" +
        result.error.issues
          .map((i) => `  ${i.path.join(".")}: ${i.message}`)
          .join("\n")
    );
    process.exit(1);
  }
  return result.data;
}

// ── CLI args ──────────────────────────────────────────────────────────────────

const ArgsSchema = z.object({
  projectIds: z.array(z.number().int().positive()).min(1),
  suiteIds: z.array(z.number().int().positive()).optional(),
  skipCases: z.boolean().default(false),
  skipResults: z.boolean().default(false),
  fullSync: z.boolean().default(false),
  updatedAfter: z.coerce.date().optional(),
  batchSize: z.coerce.number().int().min(1).max(250).default(250),
  dryRun: z.boolean().default(false),
  explain: z.boolean().default(false),
});

type Args = z.infer<typeof ArgsSchema>;

async function parseArgs(env: Env): Promise<Args> {
  const y = await yargs(hideBin(process.argv))
    .scriptName("sync-testrail")
    .usage("$0 --project-ids 1,2 [options]")
    .option("project-ids", {
      type: "string",
      describe:
        "Comma-separated TestRail project IDs to sync (env: TESTRAIL_PROJECT_IDS)",
      default: env.TESTRAIL_PROJECT_IDS ?? "",
    })
    .option("suite-ids", {
      type: "string",
      describe:
        "Comma-separated suite IDs to restrict case sync (default: all suites in project)",
    })
    .option("skip-cases", {
      type: "boolean",
      default: false,
      describe: "Skip case + link sync (only sync run results)",
    })
    .option("skip-results", {
      type: "boolean",
      default: false,
      describe: "Skip run result sync (only sync cases + links)",
    })
    .option("full-sync", {
      type: "boolean",
      default: false,
      describe:
        "Ignore incremental watermark and fetch all matching runs for result sync",
    })
    .option("updated-after", {
      type: "string",
      describe:
        "ISO datetime — only fetch cases updated after this date (phase 1 filter)",
    })
    .option("batch-size", {
      type: "number",
      default: 250,
      describe: "TestRail API page size (max 250)",
    })
    .option("dry-run", {
      type: "boolean",
      default: false,
      describe: "Fetch and map without writing to the database",
    })
    .option("explain", {
      type: "boolean",
      default: false,
      describe: "Verbose progress logging",
    })
    .help()
    .parse();

  const rawIds = (y["project-ids"] as string)
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);

  if (rawIds.length === 0) {
    console.error(
      "Error: no project IDs specified. Use --project-ids 1,2 or set TESTRAIL_PROJECT_IDS env var."
    );
    process.exit(1);
  }

  const rawSuiteIds = (y["suite-ids"] as string | undefined)
    ?.split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);

  return ArgsSchema.parse({
    projectIds: rawIds,
    suiteIds: rawSuiteIds?.length ? rawSuiteIds : undefined,
    skipCases: y["skip-cases"],
    skipResults: y["skip-results"],
    fullSync: y["full-sync"],
    updatedAfter: y["updated-after"]
      ? new Date(y["updated-after"] as string)
      : undefined,
    batchSize: y["batch-size"],
    dryRun: y["dry-run"],
    explain: y["explain"],
  });
}

// ── TestRail API types ────────────────────────────────────────────────────────

type TrSuite = {
  id: number;
  name: string;
  project_id: number;
  is_completed: boolean;
  description: string | null;
};

type TrSection = {
  id: number;
  suite_id: number;
  parent_id: number | null;
  name: string;
  depth: number;
};

type TrCase = {
  id: number;
  title: string;
  section_id: number;
  suite_id: number;
  priority_id: number;
  refs: string | null;
  updated_on: number; // Unix seconds
  [key: string]: unknown; // custom_* fields
};

type TrRun = {
  id: number;
  name: string;
  suite_id: number;
  project_id: number;
  is_completed: boolean;
  created_on: number; // Unix seconds
  completed_on: number | null;
};

type TrResult = {
  id: number;
  test_id: number;
  case_id: number;
  run_id: number;
  status_id: number;
  created_on: number; // Unix seconds — used as tested_at
};

type TrPriority = {
  id: number;
  name: string;
};

// ── TestRail API client ───────────────────────────────────────────────────────

class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSec: number
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

async function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 4,
  baseDelayMs = 1_000
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      let delayMs: number;
      if (err instanceof RateLimitError) {
        delayMs = err.retryAfterSec * 1_000;
        console.warn(
          `[retry] Rate-limited — waiting ${err.retryAfterSec}s before retry ${attempt + 1}/${maxAttempts}`
        );
      } else {
        delayMs = baseDelayMs * 2 ** (attempt - 1); // 1s → 2s → 4s
        console.warn(
          `[retry] Attempt ${attempt} failed (${(err as Error).message}) — retrying in ${delayMs}ms`
        );
      }
      await sleep(delayMs);
    }
  }
  throw lastError;
}

class TestRailClient {
  private readonly authHeader: string;
  // e.g. "https://yourorg.testrail.io/index.php?/api/v2"
  // The "?" is part of TestRail's routing scheme, not a query string delimiter.
  // Additional query params must be appended with "&", not "?".
  private readonly apiBase: string;

  constructor(env: Env) {
    const creds = Buffer.from(
      `${env.TESTRAIL_EMAIL}:${env.TESTRAIL_API_TOKEN}`
    ).toString("base64");
    this.authHeader = `Basic ${creds}`;
    this.apiBase = `${env.TESTRAIL_BASE_URL}/index.php?/api/v2`;
  }

  /**
   * Single non-paginated GET — for endpoints that return small, complete arrays.
   * (e.g. get_priorities, get_suites/:id)
   */
  async get<T>(path: string): Promise<T> {
    return withRetry(async () => {
      const resp = await fetch(`${this.apiBase}/${path}`, {
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
        },
      });

      if (resp.status === 429) {
        const retryAfterSec = parseInt(
          resp.headers.get("Retry-After") ?? "60",
          10
        );
        throw new RateLimitError("TestRail rate limit (429)", retryAfterSec);
      }

      if (!resp.ok) {
        const body = await resp.text().catch(() => "(unreadable body)");
        throw new Error(
          `TestRail API ${resp.status} ${resp.statusText}: ${body}`
        );
      }

      return resp.json() as Promise<T>;
    });
  }

  /**
   * Async-generator paginator.
   *
   * `basePath`  — path segment after /api/v2/, including any required embedded
   *               params in "&key=value" form (NOT limit/offset).
   * `arrayKey`  — key in the response object that holds the items array.
   * `pageSize`  — records per page (max 250 for TestRail Cloud).
   *
   * Handles both response formats:
   *   Old / self-hosted (≤ v6): bare JSON array — all results in one page.
   *   New / Cloud (≥ v7):       { offset, limit, size, _links, [arrayKey]: T[] }
   */
  async *paginate<T>(
    basePath: string,
    arrayKey: string,
    pageSize: number,
    explain: boolean
  ): AsyncGenerator<T> {
    let offset = 0;

    while (true) {
      const url =
        `${this.apiBase}/${basePath}` +
        `&limit=${pageSize}&offset=${offset}`;

      if (explain) {
        console.log(`[explain] GET ${url}`);
      }

      const raw = await withRetry(async () => {
        const resp = await fetch(url, {
          headers: {
            Authorization: this.authHeader,
            Accept: "application/json",
          },
        });

        if (resp.status === 429) {
          const retryAfterSec = parseInt(
            resp.headers.get("Retry-After") ?? "60",
            10
          );
          throw new RateLimitError(
            "TestRail rate limit (429)",
            retryAfterSec
          );
        }

        if (!resp.ok) {
          const body = await resp.text().catch(() => "(unreadable body)");
          throw new Error(
            `TestRail API ${resp.status} ${resp.statusText}: ${body}`
          );
        }

        return resp.json();
      });

      // Old format (bare array) — server returns everything in one shot.
      if (Array.isArray(raw)) {
        for (const item of raw as T[]) yield item;
        break;
      }

      // New format (wrapped page object).
      const page = raw as Record<string, unknown>;
      const items = (page[arrayKey] as T[]) ?? [];
      for (const item of items) yield item;

      // Stop if no next page link, or we got a short page.
      const links = page["_links"] as { next?: string | null } | undefined;
      if (!links?.next || items.length < pageSize) break;
      offset += items.length;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetch all sections for a suite and build a map of section_id → full path.
 * e.g. { 7 → "Regression / Login / Happy Path" }
 */
async function buildSectionPaths(
  client: TestRailClient,
  projectId: number,
  suiteId: number,
  explain: boolean
): Promise<Map<number, string>> {
  const sections: TrSection[] = [];
  for await (const s of client.paginate<TrSection>(
    `get_sections/${projectId}&suite_id=${suiteId}`,
    "sections",
    250,
    explain
  )) {
    sections.push(s);
  }

  const byId = new Map(sections.map((s) => [s.id, s]));

  function resolvePath(id: number, visited = new Set<number>()): string {
    if (visited.has(id)) return "?"; // cycle guard
    visited.add(id);
    const s = byId.get(id);
    if (!s) return "";
    if (!s.parent_id) return s.name;
    const parentPath = resolvePath(s.parent_id, visited);
    return parentPath ? `${parentPath} / ${s.name}` : s.name;
  }

  const paths = new Map<number, string>();
  for (const s of sections) paths.set(s.id, resolvePath(s.id));
  return paths;
}

/** Fetch TestRail priority definitions and return a map of id → name. */
async function fetchPriorityMap(
  client: TestRailClient
): Promise<Map<number, string>> {
  const priorities = await client.get<TrPriority[]>("get_priorities");
  return new Map(priorities.map((p) => [p.id, p.name]));
}

// ── Jira key extraction ───────────────────────────────────────────────────────

// Matches standard Jira issue keys: PROJECT-123 (project key ≥ 2 uppercase chars)
const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

function extractJiraKeys(refs: string | null | undefined): string[] {
  if (!refs) return [];
  const keys: string[] = [];
  let m: RegExpExecArray | null;
  JIRA_KEY_RE.lastIndex = 0;
  while ((m = JIRA_KEY_RE.exec(refs)) !== null) keys.push(m[1]);
  return [...new Set(keys)];
}

// ── Phase 1 — Case sync ───────────────────────────────────────────────────────

type CaseRow = {
  trCaseId: bigint;
  title: string;
  sectionPath: string | null;
  suiteId: bigint;
  priority: string | null;
  refs: string | null;
  custom: JsonValue;
  raw: JsonValue;
};

const CASE_BATCH = 50;

/**
 * Upsert a batch of testrail_case rows, then create jira_testrail_link rows
 * for any Jira keys found in refs that already exist in jira_issue.
 *
 * Returns the number of Jira links written.
 */
async function flushCaseBatch(
  rows: CaseRow[],
  knownIssueKeys: Set<string>,
  explain: boolean
): Promise<number> {
  // Upsert cases in a single transaction
  await prisma.$transaction(
    rows.map((row) =>
      prisma.testRailCase.upsert({
        where: { trCaseId: row.trCaseId },
        create: {
          trCaseId: row.trCaseId,
          title: row.title,
          sectionPath: row.sectionPath,
          suiteId: row.suiteId,
          priority: row.priority,
          refs: row.refs,
          custom: row.custom,
          raw: row.raw,
        },
        update: {
          title: row.title,
          sectionPath: row.sectionPath,
          suiteId: row.suiteId,
          priority: row.priority,
          refs: row.refs,
          custom: row.custom,
          raw: row.raw,
        },
      })
    )
  );

  // Upsert Jira links (outside the main transaction — refs may be empty)
  let linksWritten = 0;
  for (const row of rows) {
    const jiraKeys = extractJiraKeys(row.refs).filter((k) =>
      knownIssueKeys.has(k)
    );
    for (const issueKey of jiraKeys) {
      await prisma.jiraTestRailLink.upsert({
        where: {
          issueKey_trCaseId_provenance: {
            issueKey,
            trCaseId: row.trCaseId,
            provenance: "EXPLICIT",
          },
        },
        create: {
          issueKey,
          trCaseId: row.trCaseId,
          provenance: "EXPLICIT",
          confidence: "HIGH",
          evidence: `refs field: "${(row.refs ?? "").slice(0, 120)}"`,
          source: "testrail-refs",
        },
        update: {
          confidence: "HIGH",
          evidence: `refs field: "${(row.refs ?? "").slice(0, 120)}"`,
        },
      });
      linksWritten++;
    }
  }

  if (explain) {
    console.log(
      `[explain] Flushed ${rows.length} cases, ${linksWritten} Jira links`
    );
  }

  return linksWritten;
}

async function syncCases(
  client: TestRailClient,
  args: Args,
  priorityMap: Map<number, string>
): Promise<{ casesUpserted: number; linksUpserted: number }> {
  let casesUpserted = 0;
  let linksUpserted = 0;

  // Load known Jira issue keys to filter refs-based links (avoids FK violations
  // when jira_issue has not been fully populated yet).
  const knownIssueKeys = new Set(
    (await prisma.jiraIssue.findMany({ select: { issueKey: true } })).map(
      (r) => r.issueKey
    )
  );

  if (args.explain) {
    console.log(
      `[explain] ${knownIssueKeys.size} Jira issue keys loaded for link filtering`
    );
  }

  const updatedAfterUnix = args.updatedAfter
    ? Math.floor(args.updatedAfter.getTime() / 1_000)
    : undefined;

  for (const projectId of args.projectIds) {
    console.log(`\n── Cases: project ${projectId} ──────────────────────`);

    // Older TestRail returns a bare array; newer Cloud returns { suites: [...], offset, limit, size }.
    // Normalise to a plain array regardless of which shape the API returns.
    const suitesRaw = await client.get<TrSuite[] | { suites: TrSuite[] }>(`get_suites/${projectId}`);
    const suites: TrSuite[] = Array.isArray(suitesRaw) ? suitesRaw : (suitesRaw.suites ?? []);
    const filtered = args.suiteIds
      ? suites.filter((s) => args.suiteIds!.includes(s.id))
      : suites;

    if (filtered.length === 0) {
      console.log(
        `  No suites found${args.suiteIds ? ` matching --suite-ids ${args.suiteIds.join(",")}` : ""}.`
      );
      continue;
    }

    for (const suite of filtered) {
      console.log(`  Suite ${suite.id}: ${suite.name}`);

      const sectionPaths = await buildSectionPaths(
        client,
        projectId,
        suite.id,
        args.explain
      );

      const updatedParam =
        updatedAfterUnix != null ? `&updated_after=${updatedAfterUnix}` : "";

      const buf: CaseRow[] = [];

      for await (const tc of client.paginate<TrCase>(
        `get_cases/${projectId}&suite_id=${suite.id}${updatedParam}`,
        "cases",
        args.batchSize,
        args.explain
      )) {
        // Collect custom_* fields into a JSON blob.
        // JSON.parse(JSON.stringify(...)) strips non-serializable values and
        // returns `any`, satisfying Prisma's InputJsonValue constraint.
        const customRaw: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(tc)) {
          if (k.startsWith("custom_")) customRaw[k] = v;
        }

        buf.push({
          trCaseId: BigInt(tc.id),
          title: tc.title,
          sectionPath: sectionPaths.get(tc.section_id) ?? null,
          suiteId: BigInt(tc.suite_id),
          priority: priorityMap.get(tc.priority_id) ?? null,
          refs: tc.refs ?? null,
          custom: JSON.parse(JSON.stringify(customRaw)) as JsonValue,
          raw: JSON.parse(JSON.stringify(tc)) as JsonValue,
        });

        if (buf.length >= CASE_BATCH) {
          const rows = buf.splice(0);
          casesUpserted += rows.length;
          if (!args.dryRun) {
            linksUpserted += await flushCaseBatch(
              rows,
              knownIssueKeys,
              args.explain
            );
          }
        }
      }

      // Flush final partial batch
      if (buf.length > 0) {
        const rows = buf.splice(0);
        casesUpserted += rows.length;
        if (!args.dryRun) {
          linksUpserted += await flushCaseBatch(
            rows,
            knownIssueKeys,
            args.explain
          );
        }
      }
    }
  }

  return { casesUpserted, linksUpserted };
}

// ── Phase 2 — Result sync ─────────────────────────────────────────────────────

/**
 * Determine the Unix-second timestamp to use as the "created_after" filter
 * for test runs (not individual results).
 *
 * Strategy:
 *   1. --full-sync → no filter (fetch all runs).
 *   2. Otherwise → MAX(tested_at) in testrail_result minus 1-hour buffer.
 *      If the table is empty → full sync.
 */
async function resolveResultWatermark(
  fullSync: boolean,
  explain: boolean
): Promise<number | null> {
  if (fullSync) {
    if (explain)
      console.log(
        "[explain] --full-sync: no created_after filter for run listing"
      );
    return null;
  }

  const agg = await prisma.testRailResult.aggregate({ _max: { testedAt: true } });
  const maxDate = agg._max.testedAt;

  if (!maxDate) {
    if (explain)
      console.log(
        "[explain] No existing results — performing full run sync"
      );
    return null;
  }

  const watermarkUnix = Math.floor(
    (maxDate.getTime() - 60 * 60 * 1_000) / 1_000
  );

  if (explain) {
    console.log(
      `[explain] Result watermark: ${new Date(watermarkUnix * 1_000).toISOString()} ` +
        `(MAX(tested_at) − 1 h)`
    );
  }

  return watermarkUnix;
}

type ResultRow = {
  trResultId: bigint;
  trRunId: bigint;
  trCaseId: bigint;
  statusId: number;
  testedAt: Date | null;
};

const RESULT_BATCH = 100;

async function flushResultBatch(
  rows: ResultRow[],
  explain: boolean
): Promise<void> {
  await prisma.$transaction(
    rows.map((row) =>
      prisma.testRailResult.upsert({
        where: { trResultId: row.trResultId },
        create: {
          trResultId: row.trResultId,
          trRunId: row.trRunId,
          trCaseId: row.trCaseId,
          statusId: row.statusId,
          testedAt: row.testedAt,
        },
        update: {
          statusId: row.statusId,
          testedAt: row.testedAt,
        },
      })
    )
  );

  if (explain) {
    console.log(`[explain] Flushed ${rows.length} results`);
  }
}

async function syncResults(
  client: TestRailClient,
  args: Args,
  createdAfterUnix: number | null
): Promise<{ runsProcessed: number; resultsUpserted: number }> {
  let runsProcessed = 0;
  let resultsUpserted = 0;

  // Pre-load known tr_case_ids to silently skip orphan results (avoids FK errors
  // if a run contains results for cases not yet in testrail_case).
  const knownCaseIds = new Set(
    (
      await prisma.testRailCase.findMany({ select: { trCaseId: true } })
    ).map((r) => r.trCaseId)
  );

  if (args.explain) {
    console.log(
      `[explain] ${knownCaseIds.size} TestRail case IDs loaded for result filtering`
    );
  }

  const createdParam =
    createdAfterUnix != null ? `&created_after=${createdAfterUnix}` : "";

  for (const projectId of args.projectIds) {
    console.log(`\n── Results: project ${projectId} ────────────────────`);

    for await (const run of client.paginate<TrRun>(
      `get_runs/${projectId}${createdParam}`,
      "runs",
      args.batchSize,
      args.explain
    )) {
      if (args.explain) {
        console.log(
          `  Run ${run.id}: ${run.name} ` +
            `(created ${new Date(run.created_on * 1_000).toISOString()})`
        );
      }

      const buf: ResultRow[] = [];

      for await (const result of client.paginate<TrResult>(
        `get_results_for_run/${run.id}`,
        "results",
        args.batchSize,
        args.explain
      )) {
        // Newer TestRail Cloud omits case_id on some result records — skip those.
        if (result.case_id == null) continue;
        const caseId = BigInt(result.case_id);
        if (!knownCaseIds.has(caseId)) continue; // skip unknown cases

        if (result.id == null || result.run_id == null) continue;
        buf.push({
          trResultId: BigInt(result.id),
          trRunId: BigInt(result.run_id),
          trCaseId: caseId,
          statusId: result.status_id,
          testedAt: result.created_on
            ? new Date(result.created_on * 1_000)
            : null,
        });

        if (buf.length >= RESULT_BATCH) {
          resultsUpserted += buf.length;
          if (!args.dryRun) await flushResultBatch(buf.splice(0), args.explain);
          else buf.length = 0;
        }
      }

      // Flush final partial batch
      if (buf.length > 0) {
        resultsUpserted += buf.length;
        if (!args.dryRun) await flushResultBatch(buf.splice(0), args.explain);
        else buf.length = 0;
      }

      runsProcessed++;
    }
  }

  return { runsProcessed, resultsUpserted };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();
  const args = await parseArgs(env);
  const client = new TestRailClient(env);

  if (args.explain) {
    console.log(`[explain] Projects  : ${args.projectIds.join(", ")}`);
    console.log(
      `[explain] Suites    : ${args.suiteIds?.join(",") ?? "(all)"}`
    );
    console.log(
      `[explain] Skip cases: ${args.skipCases}, Skip results: ${args.skipResults}`
    );
    console.log(
      `[explain] Full sync : ${args.fullSync}, Dry-run: ${args.dryRun}`
    );
  }

  // ── Phase 1: Cases ──────────────────────────────────────────────────────────
  let casesUpserted = 0;
  let linksUpserted = 0;

  if (!args.skipCases) {
    console.log("\n═══ Phase 1: Syncing test cases ═══");

    const priorityMap = await fetchPriorityMap(client);
    if (args.explain) {
      console.log(`[explain] Loaded ${priorityMap.size} priority definitions`);
    }

    ({ casesUpserted, linksUpserted } = await syncCases(
      client,
      args,
      priorityMap
    ));

    if (args.dryRun) {
      console.log(
        `\n[dry-run] Would upsert ${casesUpserted} cases` +
          ` | ${linksUpserted} Jira links (links are 0 in dry-run — refs counted but not linked)`
      );
    } else {
      console.log(
        `\nCases: ${casesUpserted} upserted, ${linksUpserted} Jira links written`
      );
    }
  }

  // ── Phase 2: Results ────────────────────────────────────────────────────────
  let runsProcessed = 0;
  let resultsUpserted = 0;

  if (!args.skipResults) {
    console.log("\n═══ Phase 2: Syncing run results ═══");

    const createdAfterUnix = await resolveResultWatermark(
      args.fullSync,
      args.explain
    );

    ({ runsProcessed, resultsUpserted } = await syncResults(
      client,
      args,
      createdAfterUnix
    ));

    if (args.dryRun) {
      console.log(
        `\n[dry-run] Would process ${runsProcessed} runs, ${resultsUpserted} results`
      );
    } else {
      console.log(
        `\nRuns: ${runsProcessed} processed, Results: ${resultsUpserted} upserted`
      );
    }
  }

  if (args.dryRun) {
    console.log("\n[dry-run] No data was written to the database.");
  }
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
