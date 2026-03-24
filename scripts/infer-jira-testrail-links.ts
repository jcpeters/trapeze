#!/usr/bin/env node
/**
 * infer-jira-testrail-links.ts
 *
 * Infers jira_testrail_link rows by bridging through data already present
 * in the database.  Three complementary strategies, run in priority order:
 *
 *   Strategy A — DB join bridge  (INFERRED / HIGH)
 *   ────────────────────────────────────────────────
 *   Joins jira_automation_link and automation_testrail_link on test_case_id.
 *   No title matching required — both sides are already-confirmed links.
 *
 *     jira_automation_link (issueKey → testCaseId)
 *       JOIN automation_testrail_link (testCaseId → trCaseId)
 *       ⟹ jira_testrail_link (issueKey → trCaseId, INFERRED / HIGH)
 *
 *   This is the strongest inference because it composes two independently
 *   established relationships.  Confidence is HIGH regardless of the
 *   confidence of the source links (a MED auto-link + MED testrail-link
 *   still yields a HIGH jira-testrail link — the transitive path is clear).
 *
 *   Strategy B — Title bridge  (INFERRED / MED)
 *   ─────────────────────────────────────────────
 *   For TestRail cases without a link after Strategy A, normalizes
 *   testrail_case.title and test_case.title, finds exact normalized matches,
 *   then follows jira_automation_link to get the Jira issue key.
 *
 *     normalize(testrail_case.title) == normalize(test_case.title)
 *       → test_case.jiraLinks → issueKey
 *       ⟹ jira_testrail_link (issueKey → trCaseId, INFERRED / MED)
 *
 *   Strategy C — Title similarity  (INFERRED / MED)
 *   ──────────────────────────────────────────────────
 *   For TestRail cases still unlinked after A and B, computes a Jaccard
 *   token-overlap score between testrail_case.title and jira_issue.summary.
 *   Only emits a link if the score meets --min-similarity (default 0.45) AND
 *   the match is unambiguous (no close second within --ambiguity-gap).
 *
 * All strategies skip TestRail cases that already have EXPLICIT links
 * (written by sync-testrail from the TestRail refs field).
 *
 * Safe to re-run — upserts on (issueKey, trCaseId, provenance=INFERRED).
 * EXPLICIT and MANUAL rows are never touched.
 *
 * Typical workflow:
 *   1. npm run etl:sync:jira              # populate jira_issue
 *   2. npm run etl:sync:testrail          # populate testrail_case
 *   3. npm run etl:ingest:junit (or playwright)   # populate test_case + jira_automation_link
 *   4. npm run etl:infer:testrail         # populate automation_testrail_link
 *   5. npm run etl:infer:jira-testrail    # this script
 *
 * Usage:
 *   npm run etl:infer:jira-testrail
 *   npm run etl:infer:jira-testrail -- --dry-run --explain
 *   npm run etl:infer:jira-testrail -- --strategy a
 *   npm run etl:infer:jira-testrail -- --strategy b
 *   npm run etl:infer:jira-testrail -- --strategy c --min-similarity 0.5
 *   npm run etl:infer:jira-testrail -- --jira-projects QAA
 *   npm run etl:infer:jira-testrail -- --reset
 */

import "dotenv/config";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { z } from "zod";

import { prisma } from "./db/prisma";

// ── CLI args ───────────────────────────────────────────────────────────────────

const ArgsSchema = z.object({
  strategy: z.enum(["a", "b", "c", "all"]).default("all"),
  minSimilarity: z.coerce.number().min(0).max(1).default(0.45),
  ambiguityGap: z.coerce.number().min(0).max(1).default(0.15),
  jiraProjects: z.array(z.string()).optional(),
  reset: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  explain: z.boolean().default(false),
});

type Args = z.infer<typeof ArgsSchema>;

async function parseArgs(): Promise<Args> {
  const y = await yargs(hideBin(process.argv))
    .scriptName("infer-jira-testrail-links")
    .usage("$0 [options]")
    .option("strategy", {
      type: "string",
      choices: ["a", "b", "c", "all"] as const,
      default: "all",
      describe:
        '"a" = DB join bridge, "b" = title bridge, "c" = title similarity, "all" = run all three in order',
    })
    .option("min-similarity", {
      type: "number",
      default: 0.45,
      describe: "Strategy C: minimum Jaccard token-overlap score (0.0–1.0)",
    })
    .option("ambiguity-gap", {
      type: "number",
      default: 0.15,
      describe:
        "Strategy C: suppress match if top-2 scores are within this gap of each other",
    })
    .option("jira-projects", {
      type: "string",
      describe:
        "Comma-separated Jira project keys to restrict inference (e.g. QAA). Default: all.",
    })
    .option("reset", {
      type: "boolean",
      default: false,
      describe:
        "Delete all INFERRED jira_testrail_link rows before re-running (does not touch EXPLICIT/MANUAL)",
    })
    .option("dry-run", {
      type: "boolean",
      default: false,
      describe: "Compute links without writing to the database",
    })
    .option("explain", {
      type: "boolean",
      default: false,
      describe: "Verbose output — print each candidate match",
    })
    .help()
    .parse();

  const jiraProjects = (y["jira-projects"] as string | undefined)
    ?.split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  return ArgsSchema.parse({
    strategy: y["strategy"],
    minSimilarity: y["min-similarity"],
    ambiguityGap: y["ambiguity-gap"],
    jiraProjects: jiraProjects?.length ? jiraProjects : undefined,
    reset: y["reset"],
    dryRun: y["dry-run"],
    explain: y["explain"],
  });
}

// ── Title normalization ────────────────────────────────────────────────────────

function normalizeTitle(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(
      /^\s*(verify\s+that|test\s+that|ensure\s+that|check\s+that|should|it\s+should)\s+/,
      ""
    )
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "in", "on", "to", "for",
  "is", "are", "be", "can", "with", "from", "that", "this", "it",
  "as", "at", "by", "not", "no", "do", "does", "when", "if", "then",
  "user", "users", "should", "must", "will",
]);

function tokenize(normalized: string): Set<string> {
  return new Set(
    normalized
      .split(/\s+/)
      .filter((t) => t.length >= 2 && !STOP_WORDS.has(t))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type InferredLink = {
  issueKey: string;
  trCaseId: bigint;
  confidence: "HIGH" | "MED";
  evidence: string;
  source: string;
};

// ── Strategy A: DB join bridge ────────────────────────────────────────────────

async function runStrategyA(
  args: Args,
  alreadyLinkedCaseIds: Set<bigint>,
  restrictToIssueKeys?: Set<string>
): Promise<InferredLink[]> {
  console.log("\n── Strategy A: DB join bridge ───────────────────────────────");

  // Join jira_automation_link ↔ automation_testrail_link on test_case_id
  const rows = await prisma.jiraAutomationLink.findMany({
    where: restrictToIssueKeys
      ? { issueKey: { in: [...restrictToIssueKeys] } }
      : undefined,
    select: {
      issueKey: true,
      confidence: true,
      testCase: {
        select: {
          id: true,
          title: true,
          trLinks: {
            select: {
              trCaseId: true,
              confidence: true,
              source: true,
            },
          },
        },
      },
    },
  });

  const results: InferredLink[] = [];
  const seen = new Set<string>(); // deduplicate issueKey:trCaseId pairs

  for (const jal of rows) {
    if (!jal.testCase) continue;
    for (const atrl of jal.testCase.trLinks) {
      if (alreadyLinkedCaseIds.has(atrl.trCaseId)) continue;
      const key = `${jal.issueKey}:${atrl.trCaseId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        issueKey: jal.issueKey,
        trCaseId: atrl.trCaseId,
        confidence: "HIGH",
        evidence: `DB bridge via TestCase "${jal.testCase.title}" (jira_automation_link + automation_testrail_link)`,
        source: "infer-jira-testrail:db-bridge",
      });

      if (args.explain) {
        console.log(
          `  [A] ${jal.issueKey} → TR-${atrl.trCaseId}` +
            ` via "${jal.testCase.title}" (atrl.source=${atrl.source})`
        );
      }
    }
  }

  console.log(`  Strategy A: ${results.length} inferred link(s)`);
  return results;
}

// ── Strategy B: Title bridge ──────────────────────────────────────────────────

async function runStrategyB(
  args: Args,
  alreadyLinkedCaseIds: Set<bigint>,
  coveredTrCaseIds: Set<bigint>,
  restrictToIssueKeys?: Set<string>
): Promise<InferredLink[]> {
  console.log("\n── Strategy B: Title bridge ──────────────────────────────────");

  // TestRail cases not yet covered
  const trCases = await prisma.testRailCase.findMany({
    select: { trCaseId: true, title: true },
  });
  const unlinkedTrCases = trCases.filter(
    (c) => !alreadyLinkedCaseIds.has(c.trCaseId) && !coveredTrCaseIds.has(c.trCaseId)
  );

  if (args.explain) {
    console.log(
      `  ${unlinkedTrCases.length} TestRail cases without EXPLICIT or Strategy-A links`
    );
  }

  // Load TestCases that have Jira links, with their normalized titles
  const testCasesWithLinks = await prisma.testCase.findMany({
    select: {
      title: true,
      jiraLinks: {
        select: { issueKey: true, confidence: true },
        where: restrictToIssueKeys
          ? { issueKey: { in: [...restrictToIssueKeys] } }
          : undefined,
      },
    },
    where: { jiraLinks: { some: {} } },
  });

  // Build map: normalizedTitle → issueKey[]
  const byNorm = new Map<string, string[]>();
  for (const tc of testCasesWithLinks) {
    const norm = normalizeTitle(tc.title);
    if (!norm) continue;
    const keys = byNorm.get(norm) ?? [];
    for (const link of tc.jiraLinks) {
      if (!keys.includes(link.issueKey)) keys.push(link.issueKey);
    }
    byNorm.set(norm, keys);
  }

  const results: InferredLink[] = [];

  for (const trCase of unlinkedTrCases) {
    const norm = normalizeTitle(trCase.title);
    if (!norm) continue;
    const issueKeys = byNorm.get(norm);
    if (!issueKeys?.length) continue;

    for (const issueKey of issueKeys) {
      results.push({
        issueKey,
        trCaseId: trCase.trCaseId,
        confidence: "MED",
        evidence: `title match: "${trCase.title}" → TestCase with same normalized title`,
        source: "infer-jira-testrail:title-bridge",
      });
      if (args.explain) {
        console.log(
          `  [B] ${issueKey} → TR-${trCase.trCaseId} via title match "${trCase.title}"`
        );
      }
    }
  }

  console.log(`  Strategy B: ${results.length} inferred link(s)`);
  return results;
}

// ── Strategy C: Title similarity ──────────────────────────────────────────────

async function runStrategyC(
  args: Args,
  alreadyLinkedCaseIds: Set<bigint>,
  coveredTrCaseIds: Set<bigint>,
  restrictToIssueKeys?: Set<string>
): Promise<InferredLink[]> {
  console.log("\n── Strategy C: Title similarity ──────────────────────────────");

  const trCases = await prisma.testRailCase.findMany({
    select: { trCaseId: true, title: true },
  });
  const unlinkedTrCases = trCases.filter(
    (c) =>
      !alreadyLinkedCaseIds.has(c.trCaseId) &&
      !coveredTrCaseIds.has(c.trCaseId)
  );

  const jiraIssues = await prisma.jiraIssue.findMany({
    select: { issueKey: true, summary: true },
    where: restrictToIssueKeys
      ? { issueKey: { in: [...restrictToIssueKeys] } }
      : undefined,
  });

  if (args.explain) {
    console.log(
      `  ${unlinkedTrCases.length} TestRail cases to match against ${jiraIssues.length} Jira issues`
    );
  }

  const jiraTokenized = jiraIssues.map((issue) => ({
    issueKey: issue.issueKey,
    summary: issue.summary ?? "",
    tokens: tokenize(normalizeTitle(issue.summary)),
  }));

  const results: InferredLink[] = [];

  for (const trCase of unlinkedTrCases) {
    if (!trCase.title) continue;
    const trTokens = tokenize(normalizeTitle(trCase.title));
    if (trTokens.size === 0) continue;

    const scored = jiraTokenized
      .map((j) => ({ ...j, score: jaccard(trTokens, j.tokens) }))
      .filter((j) => j.score >= args.minSimilarity)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) continue;

    // Suppress ambiguous matches
    if (
      scored.length >= 2 &&
      scored[0].score - scored[1].score < args.ambiguityGap
    ) {
      if (args.explain) {
        console.log(
          `  [C] TR-${trCase.trCaseId} "${trCase.title}" — AMBIGUOUS:` +
            ` ${scored[0].issueKey}(${scored[0].score.toFixed(2)}) vs` +
            ` ${scored[1].issueKey}(${scored[1].score.toFixed(2)}) — skipped`
        );
      }
      continue;
    }

    const best = scored[0];
    results.push({
      issueKey: best.issueKey,
      trCaseId: trCase.trCaseId,
      confidence: "MED",
      evidence:
        `title similarity ${(best.score * 100).toFixed(0)}%: ` +
        `"${trCase.title}" ~ "${best.summary}"`,
      source: "infer-jira-testrail:similarity",
    });

    if (args.explain) {
      console.log(
        `  [C] ${best.issueKey} → TR-${trCase.trCaseId}` +
          ` (score=${best.score.toFixed(2)}): "${trCase.title}" ~ "${best.summary}"`
      );
    }
  }

  console.log(`  Strategy C: ${results.length} inferred link(s)`);
  return results;
}

// ── Write links ───────────────────────────────────────────────────────────────

async function writeLinks(links: InferredLink[], dryRun: boolean): Promise<number> {
  if (dryRun) return links.length;

  let written = 0;
  for (const link of links) {
    await prisma.jiraTestRailLink.upsert({
      where: {
        issueKey_trCaseId_provenance: {
          issueKey: link.issueKey,
          trCaseId: link.trCaseId,
          provenance: "INFERRED",
        },
      },
      create: {
        issueKey: link.issueKey,
        trCaseId: link.trCaseId,
        provenance: "INFERRED",
        confidence: link.confidence,
        evidence: link.evidence.slice(0, 250),
        source: link.source,
      },
      update: {
        confidence: link.confidence,
        evidence: link.evidence.slice(0, 250),
        source: link.source,
      },
    });
    written++;
  }
  return written;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = await parseArgs();

  if (args.explain) {
    console.log(`[explain] Strategy      : ${args.strategy}`);
    console.log(`[explain] Min similarity: ${args.minSimilarity}`);
    console.log(`[explain] Ambiguity gap : ${args.ambiguityGap}`);
    console.log(`[explain] Jira projects : ${args.jiraProjects?.join(",") ?? "(all)"}`);
    console.log(`[explain] Reset         : ${args.reset}`);
    console.log(`[explain] Dry-run       : ${args.dryRun}`);
  }

  // Optional reset of all INFERRED rows
  if (args.reset && !args.dryRun) {
    const deleted = await prisma.jiraTestRailLink.deleteMany({
      where: { provenance: "INFERRED" },
    });
    console.log(`[reset] Deleted ${deleted.count} existing INFERRED jira_testrail_link rows`);
  }

  // Restrict Jira side to specified projects
  let restrictToIssueKeys: Set<string> | undefined;
  if (args.jiraProjects?.length) {
    const rows = await prisma.jiraIssue.findMany({
      where: { projectKey: { in: args.jiraProjects } },
      select: { issueKey: true },
    });
    restrictToIssueKeys = new Set(rows.map((r) => r.issueKey));
    if (args.explain) {
      console.log(
        `\n[explain] Restricted to ${restrictToIssueKeys.size} issue keys` +
          ` from projects: ${args.jiraProjects.join(", ")}`
      );
    }
  }

  // Load TestRail cases that already have EXPLICIT links — always skip these
  const explicitRows = await prisma.jiraTestRailLink.findMany({
    where: { provenance: "EXPLICIT" },
    select: { trCaseId: true },
  });
  const alreadyLinkedCaseIds = new Set(explicitRows.map((r) => r.trCaseId));

  if (args.explain) {
    console.log(
      `\n[explain] ${alreadyLinkedCaseIds.size} TestRail cases have EXPLICIT links — will skip`
    );
  }

  const runA = args.strategy === "a" || args.strategy === "all";
  const runB = args.strategy === "b" || args.strategy === "all";
  const runC = args.strategy === "c" || args.strategy === "all";

  let aLinks: InferredLink[] = [];
  let bLinks: InferredLink[] = [];
  let cLinks: InferredLink[] = [];

  if (runA) {
    aLinks = await runStrategyA(args, alreadyLinkedCaseIds, restrictToIssueKeys);
  }

  // For B and C, exclude cases already covered by A
  const aCoveredIds = new Set(aLinks.map((l) => l.trCaseId));

  if (runB) {
    bLinks = await runStrategyB(args, alreadyLinkedCaseIds, aCoveredIds, restrictToIssueKeys);
  }

  // For C, also exclude cases covered by B
  const bcCoveredIds = new Set([...aCoveredIds, ...bLinks.map((l) => l.trCaseId)]);

  if (runC) {
    cLinks = await runStrategyC(args, alreadyLinkedCaseIds, bcCoveredIds, restrictToIssueKeys);
  }

  const allLinks = [...aLinks, ...bLinks, ...cLinks];

  const aWritten = await writeLinks(aLinks, args.dryRun);
  const bWritten = await writeLinks(bLinks, args.dryRun);
  const cWritten = await writeLinks(cLinks, args.dryRun);

  const total = aWritten + bWritten + cWritten;
  const prefix = args.dryRun ? "[dry-run] Would write" : "Written";

  console.log(
    `\n${prefix} ${total} link(s): ` +
      `${aWritten} DB-bridge (HIGH), ` +
      `${bWritten} title-bridge (MED), ` +
      `${cWritten} similarity (MED)`
  );

  if (args.dryRun) {
    console.log("[dry-run] No data was written to the database.");
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
