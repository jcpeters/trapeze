#!/usr/bin/env node
/**
 * sync-jira.ts
 *
 * Fetches Jira issues from the Jira Cloud REST API v3 and upserts them
 * into the jira_issue table.  Designed to be called nightly by a cron
 * job or Jenkins pipeline step.
 *
 * Usage:
 *   npx tsx ./scripts/sync-jira.ts --projects QAA,PROJ [options]
 *
 * Required env vars (see .env):
 *   JIRA_BASE_URL    https://yourorg.atlassian.net
 *   JIRA_EMAIL       service-account@yourorg.com
 *   JIRA_API_TOKEN   <Atlassian personal access token>
 *
 * Optional env vars:
 *   JIRA_PROJECTS    Comma-separated default project list (--projects flag overrides)
 */

import "dotenv/config";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { z } from "zod";

import { prisma } from "./db/prisma";

// ─────────────────────────────────────────────
// Environment
// ─────────────────────────────────────────────

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JIRA_BASE_URL: z
    .string()
    .url()
    .transform((u) => u.replace(/\/$/, "")),
  JIRA_EMAIL: z.string().min(1),
  JIRA_API_TOKEN: z.string().min(1),
  JIRA_PROJECTS: z.string().optional(), // fallback for --projects
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

// ─────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────

const ArgsSchema = z.object({
  projects: z.array(z.string().min(1)).min(1),
  issueTypes: z
    .array(z.string())
    .default(["Story", "Bug", "Task", "Epic", "Sub-task"]),
  updatedAfter: z.coerce.date().optional(), // explicit override
  fullSync: z.boolean().default(false),     // skip incremental watermark
  pageSize: z.coerce.number().int().min(1).max(100).default(100),
  dryRun: z.boolean().default(false),
  explain: z.boolean().default(false),
});

type Args = z.infer<typeof ArgsSchema>;

async function parseArgs(env: Env): Promise<Args> {
  const y = await yargs(hideBin(process.argv))
    .scriptName("sync-jira")
    .usage("$0 --projects PROJ,QAA [options]")
    .option("projects", {
      type: "string",
      describe:
        "Comma-separated Jira project keys to sync (env: JIRA_PROJECTS)",
      default: env.JIRA_PROJECTS ?? "",
    })
    .option("issue-types", {
      type: "string",
      default: "Story,Bug,Task,Epic,Sub-task",
      describe: "Comma-separated issue types to include",
    })
    .option("updated-after", {
      type: "string",
      describe:
        "ISO datetime — only fetch issues updated after this (default: auto-detect from DB)",
    })
    .option("full-sync", {
      type: "boolean",
      default: false,
      describe: "Ignore incremental watermark and fetch all matching issues",
    })
    .option("page-size", {
      type: "number",
      default: 100,
      describe: "Jira API results per page (max 100)",
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

  const rawProjects = (y.projects as string)
    .split(",")
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);

  if (rawProjects.length === 0) {
    console.error(
      "Error: no projects specified. Use --projects QAA,PROJ or set JIRA_PROJECTS env var."
    );
    process.exit(1);
  }

  return ArgsSchema.parse({
    projects: rawProjects,
    issueTypes: (y["issue-types"] as string)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    updatedAfter: y["updated-after"]
      ? new Date(y["updated-after"] as string)
      : undefined,
    fullSync: y["full-sync"],
    pageSize: y["page-size"],
    dryRun: y["dry-run"],
    explain: y["explain"],
  });
}

// ─────────────────────────────────────────────
// Jira API types  (minimal subset of v3 response)
// ─────────────────────────────────────────────

type JiraFields = {
  summary?: string | null;
  status?: { name: string } | null;
  issuetype?: { name: string } | null;
  priority?: { name: string } | null;
  labels?: string[];
  created?: string | null;
  updated?: string | null;
  resolutiondate?: string | null;
  parent?: { key: string } | null;
  project?: { key: string } | null;
  // Classic projects epic link; may be absent on next-gen
  customfield_10014?: string | null;
  fixVersions?: { name: string }[];
  components?: { name: string }[];
};

type JiraIssueRaw = {
  id: string;
  key: string;
  fields: JiraFields;
};

type JiraSearchPage = {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssueRaw[];
};

// ─────────────────────────────────────────────
// Jira API client
// ─────────────────────────────────────────────

// Fields requested on every search page — extend here if you add schema columns.
const REQUESTED_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "labels",
  "created",
  "updated",
  "resolutiondate",
  "parent",
  "project",
  "customfield_10014", // Epic Link (classic projects)
  "fixVersions",
  "components",
].join(",");

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
          `[retry] Rate-limited by Jira — waiting ${err.retryAfterSec}s before retry ${attempt + 1}/${maxAttempts}`
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

class JiraClient {
  private readonly authHeader: string;

  constructor(private readonly env: Env) {
    const creds = Buffer.from(
      `${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`
    ).toString("base64");
    this.authHeader = `Basic ${creds}`;
  }

  private async fetchPage(
    jql: string,
    startAt: number,
    maxResults: number
  ): Promise<JiraSearchPage> {
    return withRetry(async () => {
      const url = new URL(`${this.env.JIRA_BASE_URL}/rest/api/3/search`);
      url.searchParams.set("jql", jql);
      url.searchParams.set("startAt", String(startAt));
      url.searchParams.set("maxResults", String(maxResults));
      url.searchParams.set("fields", REQUESTED_FIELDS);

      const resp = await fetch(url.toString(), {
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
        },
      });

      if (resp.status === 429) {
        const retryAfter = parseInt(
          resp.headers.get("Retry-After") ?? "60",
          10
        );
        throw new RateLimitError(
          `Jira rate limit hit (429)`,
          retryAfter
        );
      }

      if (!resp.ok) {
        const body = await resp.text().catch(() => "(unreadable body)");
        throw new Error(
          `Jira API error ${resp.status} ${resp.statusText}: ${body}`
        );
      }

      return resp.json() as Promise<JiraSearchPage>;
    });
  }

  /** Async generator that yields every issue across all pages. */
  async *paginate(
    jql: string,
    pageSize: number,
    explain: boolean
  ): AsyncGenerator<JiraIssueRaw> {
    let startAt = 0;
    let total: number | null = null;

    do {
      if (explain) {
        const progress =
          total != null ? ` of ${total}` : "";
        console.log(
          `[explain] Fetching page: startAt=${startAt}${progress} pageSize=${pageSize}`
        );
      }

      const page = await this.fetchPage(jql, startAt, pageSize);
      total = page.total;

      for (const issue of page.issues) {
        yield issue;
      }

      startAt += page.issues.length;

      // Jira occasionally returns 0 results before total is exhausted —
      // guard against an infinite loop.
      if (page.issues.length === 0) break;
    } while (startAt < (total ?? 0));
  }
}

// ─────────────────────────────────────────────
// Mapping: raw Jira issue → DB shape
// ─────────────────────────────────────────────

type MappedIssue = {
  issueKey: string;
  issueType: string;
  summary: string | null;
  status: string | null;
  parentKey: string | null;
  projectKey: string | null;
  priority: string | null;
  labels: string[];
  createdAt: Date | null;
  updatedAt: Date | null;
  resolvedAt: Date | null;
  raw: JiraIssueRaw;
};

function toDate(iso?: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function extractParentKey(fields: JiraFields): string | null {
  // Next-gen (team-managed) projects expose parent.key directly.
  if (fields.parent?.key) return fields.parent.key;
  // Classic projects use customfield_10014 for Epic Link.
  if (fields.customfield_10014) return fields.customfield_10014;
  return null;
}

function mapIssue(raw: JiraIssueRaw): MappedIssue {
  const f = raw.fields;
  // Derive projectKey from the issue key (e.g. "QAA-123" → "QAA") as a
  // fallback if the project field is absent.
  const projectKey =
    f.project?.key ?? raw.key.split("-")[0] ?? null;

  return {
    issueKey: raw.key,
    issueType: f.issuetype?.name ?? "Unknown",
    summary: f.summary ?? null,
    status: f.status?.name ?? null,
    parentKey: extractParentKey(f),
    projectKey,
    priority: f.priority?.name ?? null,
    labels: f.labels ?? [],
    createdAt: toDate(f.created),
    updatedAt: toDate(f.updated),
    resolvedAt: toDate(f.resolutiondate),
    raw,
  };
}

// ─────────────────────────────────────────────
// Incremental watermark
// ─────────────────────────────────────────────

/**
 * Determines the `updatedAfter` threshold for the JQL query.
 *
 * Strategy:
 *   1. If --full-sync is set → return null (no filter).
 *   2. If --updated-after is set explicitly → use that.
 *   3. Otherwise, query the DB for MAX(updated_at) per requested project.
 *      - If any project has no records → full sync (return null).
 *      - Otherwise use MIN of those per-project maxes, minus a 1-hour
 *        buffer to guard against clock skew or delayed indexing.
 */
async function resolveUpdatedAfter(
  projects: string[],
  explicitDate: Date | undefined,
  fullSync: boolean,
  explain: boolean
): Promise<Date | null> {
  if (fullSync) {
    if (explain) console.log("[explain] --full-sync: no updatedAfter filter");
    return null;
  }

  if (explicitDate) {
    if (explain)
      console.log(
        `[explain] Using explicit updatedAfter=${explicitDate.toISOString()}`
      );
    return explicitDate;
  }

  // Per-project MAX(updated_at) watermarks
  const rows = await prisma.jiraIssue.groupBy({
    by: ["projectKey"],
    where: { projectKey: { in: projects } },
    _max: { updatedAt: true },
  });

  // Check every requested project has at least one record
  const coveredProjects = new Set(
    rows.map((r) => r.projectKey).filter(Boolean)
  );
  const missingProject = projects.find((p) => !coveredProjects.has(p));

  if (missingProject) {
    if (explain)
      console.log(
        `[explain] Project "${missingProject}" has no existing records — performing full sync`
      );
    return null;
  }

  // Take the MIN of the per-project maxes (oldest newest-update)
  const minMaxDate = rows.reduce<Date | null>((acc, row) => {
    const d = row._max.updatedAt;
    if (!d) return null; // treat missing as "needs full sync"
    if (!acc) return d;
    return d < acc ? d : acc;
  }, null);

  if (!minMaxDate) {
    if (explain)
      console.log("[explain] Could not determine watermark — performing full sync");
    return null;
  }

  // Subtract 1-hour buffer
  const watermark = new Date(minMaxDate.getTime() - 60 * 60 * 1_000);
  if (explain)
    console.log(
      `[explain] Auto watermark: ${watermark.toISOString()} ` +
        `(min of per-project MAX(updated_at) − 1 h)`
    );
  return watermark;
}

// ─────────────────────────────────────────────
// JQL builder
// ─────────────────────────────────────────────

function buildJql(
  projects: string[],
  issueTypes: string[],
  updatedAfter: Date | null
): string {
  const parts: string[] = [
    `project in (${projects.map((p) => `"${p}"`).join(", ")})`,
    `issueType in (${issueTypes.map((t) => `"${t}"`).join(", ")})`,
  ];

  if (updatedAfter) {
    // Jira JQL requires: "YYYY-MM-DD HH:mm" in UTC
    const ts = updatedAfter.toISOString().replace("T", " ").slice(0, 16);
    parts.push(`updated >= "${ts}"`);
  }

  // Ascending order so that restarts/retries re-process in a predictable
  // sequence and we can resume from a known offset if needed.
  return parts.join(" AND ") + " ORDER BY updated ASC";
}

// ─────────────────────────────────────────────
// DB upsert — batched transactions
// ─────────────────────────────────────────────

const BATCH_SIZE = 50;

async function upsertBatch(
  issues: MappedIssue[],
  explain: boolean,
  batchNo: number
): Promise<void> {
  await prisma.$transaction(
    issues.map((issue) =>
      prisma.jiraIssue.upsert({
        where: { issueKey: issue.issueKey },
        create: issue,
        update: {
          // Never overwrite issueKey or createdAt — they are immutable
          // identifiers from Jira.
          issueType: issue.issueType,
          summary: issue.summary,
          status: issue.status,
          parentKey: issue.parentKey,
          projectKey: issue.projectKey,
          priority: issue.priority,
          labels: issue.labels,
          updatedAt: issue.updatedAt,
          resolvedAt: issue.resolvedAt,
          raw: issue.raw,
        },
      })
    )
  );

  if (explain) {
    console.log(
      `[explain] Batch ${batchNo}: upserted ${issues.length} issues` +
        ` (${issues[0].issueKey} … ${issues[issues.length - 1].issueKey})`
    );
  }
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main() {
  const env = loadEnv();
  const args = await parseArgs(env);

  const updatedAfter = await resolveUpdatedAfter(
    args.projects,
    args.updatedAfter,
    args.fullSync,
    args.explain
  );

  const jql = buildJql(args.projects, args.issueTypes, updatedAfter);

  if (args.explain) {
    console.log(`[explain] Projects : ${args.projects.join(", ")}`);
    console.log(`[explain] Types    : ${args.issueTypes.join(", ")}`);
    console.log(`[explain] JQL      : ${jql}`);
    console.log(`[explain] Dry-run  : ${args.dryRun}`);
  }

  const client = new JiraClient(env);

  let fetched = 0;
  let upserted = 0;
  let batchNo = 0;
  const buffer: MappedIssue[] = [];

  for await (const rawIssue of client.paginate(
    jql,
    args.pageSize,
    args.explain
  )) {
    const mapped = mapIssue(rawIssue);
    fetched++;

    if (args.dryRun) {
      if (args.explain) {
        const summary = (mapped.summary ?? "").slice(0, 70);
        console.log(
          `[dry-run] ${mapped.issueKey.padEnd(12)} ` +
            `${(mapped.issueType ?? "").padEnd(10)} ` +
            `[${mapped.status ?? "?"}] ${summary}`
        );
      }
      continue;
    }

    buffer.push(mapped);

    if (buffer.length >= BATCH_SIZE) {
      batchNo++;
      await upsertBatch(buffer, args.explain, batchNo);
      upserted += buffer.length;
      buffer.length = 0;
    }
  }

  // Flush final partial batch
  if (!args.dryRun && buffer.length > 0) {
    batchNo++;
    await upsertBatch(buffer, args.explain, batchNo);
    upserted += buffer.length;
    buffer.length = 0;
  }

  if (args.dryRun) {
    console.log(
      `[dry-run] Would upsert ${fetched} issues` +
        ` | projects=${args.projects.join(",")}` +
        ` | updatedAfter=${updatedAfter?.toISOString() ?? "none (full sync)"}`
    );
  } else {
    console.log(
      `Sync complete` +
        ` | projects=${args.projects.join(",")}` +
        ` | fetched=${fetched}` +
        ` | upserted=${upserted}` +
        ` | updatedAfter=${updatedAfter?.toISOString() ?? "none (full sync)"}`
    );
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
