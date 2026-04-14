#!/usr/bin/env node
/**
 * infer-jira-links.ts
 *
 * Two inference modes:
 *
 * 1. KEY mode (default)
 *    Scans TestCase.identityKey, TestCase.title, and TestCase.suiteName for
 *    embedded Jira issue keys (e.g. QAA-123) and writes jira_automation_link
 *    rows with provenance=INFERRED, confidence=LOW.
 *
 * 2. SIMILARITY mode  (--similarity)
 *    Normalises TestCase.title and JiraIssue.summary to word bags, computes
 *    Jaccard similarity, and creates INFERRED links for pairs that score above
 *    --min-score (default 0.20).  Confidence is set by score:
 *      score >= 0.40  →  MED   (strong overlap)
 *      score >= 0.20  →  LOW   (moderate overlap)
 *    Only Stories, Bugs, and Tasks are candidates (Epics are excluded so that
 *    links land on the same issue types counted by v_req_universe).
 *
 * Both modes:
 *  - Never touch existing EXPLICIT or MANUAL links.
 *  - Only link to keys already in jira_issue (FK safety).
 *  - Safe to re-run — upsert on (issueKey, testCaseId, provenance=INFERRED).
 *
 * Typical workflow:
 *   1. npm run etl:sync:jira                     # populate jira_issue first
 *   2. npm run etl:ingest:junit / etl:ingest:playwright
 *   3. npm run etl:infer:jira                    # key-embedding pass
 *   4. npm run etl:infer:jira -- --similarity    # title-similarity pass
 *
 * Usage:
 *   npm run etl:infer:jira
 *   npm run etl:infer:jira -- --similarity --min-score 0.25 --explain
 *   npm run etl:infer:jira -- --similarity --dry-run --explain
 *   npm run etl:infer:jira -- --reset --explain
 */

import "dotenv/config";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { prisma } from "./db/prisma";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BATCH_SIZE = 500;

/**
 * Ordered list of TestCase fields to scan for Jira keys.
 * First field that yields a key wins for the evidence string (identity is
 * usually the most signal-rich, then title, then suite name).
 */
const SCAN_FIELDS = ["identityKey", "title", "suiteName"] as const;
type ScanField = (typeof SCAN_FIELDS)[number];

// ── Regex helpers ─────────────────────────────────────────────────────────────

/**
 * Returns all Jira issue key matches in `value` along with their position.
 * Creates a fresh RegExp per call to avoid shared-state bugs with the /g flag.
 *
 * Pattern: PROJECT-123
 *   - Project key: 2–10 uppercase alphanumeric chars, starting with a letter.
 *   - Issue number: one or more digits.
 *
 * Boundary strategy:
 *   Standard `\b` treats `_` as a word character, which breaks matching in
 *   Python-style test names like `test_QAA-100_flow` or `PROJ-42_login_google`.
 *   Instead we use:
 *     (?<![A-Z0-9])  — left boundary: not preceded by an uppercase letter or digit
 *     (?!\d)         — right boundary: not followed by another digit
 *   This correctly handles underscores, dots, colons, and hyphens as separators
 *   while still rejecting partial matches like `XQAA-100` or `PROJ-421` (as a
 *   sub-match of `PROJ-4210`).
 */
function extractJiraKeys(value: string): Array<{ key: string; index: number }> {
  const re = /(?<![A-Z0-9])([A-Z][A-Z0-9]{1,9}-\d+)(?!\d)/g;
  const results: Array<{ key: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    results.push({ key: m[1], index: m.index });
  }
  return results;
}

/**
 * Builds a short (≤60 char) excerpt centred on the match position — useful
 * for the evidence string stored in jira_automation_link.evidence.
 */
function buildSnippet(value: string, index: number, keyLen: number): string {
  const CONTEXT = 20;
  const start = Math.max(0, index - CONTEXT);
  const end = Math.min(value.length, index + keyLen + CONTEXT);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < value.length ? "…" : "";
  return `${prefix}${value.slice(start, end)}${suffix}`;
}

// ── Title-similarity helpers ──────────────────────────────────────────────────

/**
 * English stop words to strip before scoring.  Kept small — only
 * function words that carry no domain signal.
 */
const STOP_WORDS = new Set([
  // Grammatical function words
  "a", "an", "the", "and", "or", "but", "for", "nor", "so", "yet",
  "at", "by", "from", "in", "into", "of", "off", "on", "onto", "out",
  "over", "to", "up", "with", "as", "is", "are", "was", "were", "be",
  "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "can", "that", "this",
  "it", "its", "not", "no", "if", "then", "when", "where", "which",
  // Domain-generic test/action words that would cause false-positive matches
  "test", "tests", "testing", "verify", "verifies", "check", "checks",
  "validate", "validates", "ensure", "ensures", "complete", "completes",
  "update", "updates", "create", "creates", "new", "get", "set",
  "user", "users", "page", "pages", "flow", "flows", "step", "steps",
  "event", "events", "ui", "fix", "fixes",
]);

/**
 * Splits a string into a lower-cased word bag suitable for Jaccard scoring.
 * Handles camelCase, PascalCase, snake_case, kebab-case, dots, and spaces.
 * Strips digits-only tokens and stop words.
 */
function tokenize(text: string): Set<string> {
  // Insert spaces before uppercase letters that follow lowercase (camelCase split)
  const spaced = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

  // Split on any non-alphanumeric sequence
  const tokens = spaced
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !STOP_WORDS.has(t));

  return new Set(tokens);
}

/**
 * Jaccard similarity: |A ∩ B| / |A ∪ B|.
 * Returns 0 if either set is empty.
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

// ── Core scanner ──────────────────────────────────────────────────────────────

interface FoundLink {
  issueKey: string;
  field: ScanField;
  evidence: string;
}

/**
 * Scans a single TestCase row for embedded Jira issue keys.
 * Returns deduplicated matches (first-field-found wins for evidence text).
 */
function scanTestCase(tc: {
  identityKey: string;
  title: string;
  suiteName: string | null;
}): FoundLink[] {
  const seen = new Set<string>();
  const links: FoundLink[] = [];

  for (const field of SCAN_FIELDS) {
    const value: string = (tc[field] as string | null) ?? "";
    if (!value) continue;

    for (const { key, index } of extractJiraKeys(value)) {
      if (seen.has(key)) continue; // deduplicate across fields
      seen.add(key);
      const snippet = buildSnippet(value, index, key.length);
      links.push({
        issueKey: key,
        field,
        evidence: `Jira key found in ${field}: "${snippet}"`,
      });
    }
  }

  return links;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("infer-jira-links")
    .usage("$0 [options]\n\nScan TestCase names for embedded Jira keys and write INFERRED links.")
    .option("batch-size", {
      type: "number",
      default: DEFAULT_BATCH_SIZE,
      describe: "Number of TestCase rows to process per DB round-trip",
    })
    .option("dry-run", {
      alias: "n",
      type: "boolean",
      default: false,
      describe: "Scan and report without writing any rows to the database",
    })
    .option("explain", {
      type: "boolean",
      default: false,
      describe: "Print a line for every link found (verbose)",
    })
    .option("reset", {
      type: "boolean",
      default: false,
      describe:
        "Delete all existing INFERRED links written by name-inference before re-scanning " +
        "(use after bulk jira_issue import to promote earlier skipped keys)",
    })
    .option("similarity", {
      type: "boolean",
      default: false,
      describe:
        "Also run a title-similarity pass: match TestCase.title against JiraIssue.summary " +
        "using Jaccard word-overlap (Stories/Bugs/Tasks only).  Pairs scoring >= --min-score " +
        "are linked with provenance=INFERRED; MED confidence >= 0.40, LOW otherwise.",
    })
    .option("min-score", {
      type: "number",
      default: 0.20,
      describe: "Minimum Jaccard score (0–1) for a similarity link to be created",
    })
    .help()
    .parse();

  const batchSize   = argv["batch-size"]  as number;
  const dryRun      = argv["dry-run"]     as boolean;
  const explain     = argv["explain"]     as boolean;
  const doReset     = argv["reset"]       as boolean;
  const doSimilarity = argv["similarity"] as boolean;
  const minScore    = argv["min-score"]   as number;

  // ── Step 1: Load all known Jira issue keys ──────────────────────────────

  const jiraRows = await prisma.jiraIssue.findMany({ select: { issueKey: true } });
  const knownJiraKeys = new Set(jiraRows.map((r) => r.issueKey));

  if (explain) {
    console.log(`[explain] Loaded ${knownJiraKeys.size} Jira issue keys from jira_issue`);
    console.log(`[explain] Scanning fields: ${SCAN_FIELDS.join(", ")}`);
    console.log(`[explain] Batch size: ${batchSize}`);
    if (dryRun)  console.log("[explain] DRY RUN — no rows will be written");
    if (doReset) console.log("[explain] RESET — existing name-inference INFERRED links will be deleted first");
  }

  if (knownJiraKeys.size === 0) {
    console.warn(
      "jira_issue table is empty — run `npm run etl:sync:jira` first so " +
      "there are Jira keys to match against.\nExiting without changes."
    );
    return;
  }

  // ── Step 2: Optional reset of prior INFERRED / name-inference links ────

  if (doReset && !dryRun) {
    const deleted = await prisma.jiraAutomationLink.deleteMany({
      where: { provenance: "INFERRED", source: "name-inference" },
    });
    console.log(`[reset] Deleted ${deleted.count} existing name-inference INFERRED links`);
  }

  // ── Step 3: Cursor-paginate all TestCase rows ───────────────────────────

  let cursor: string | undefined;
  let totalCases    = 0;
  let linksUpserted = 0; // written (or would-be-written in dry-run)
  let linksSkipped  = 0; // key not in jira_issue
  let batchNo       = 0;

  console.log("Scanning TestCase rows for embedded Jira keys…");

  while (true) {
    const batch = await prisma.testCase.findMany({
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id:          true,
        identityKey: true,
        title:       true,
        suiteName:   true,
      },
      orderBy: { id: "asc" },
    });

    if (batch.length === 0) break;

    cursor      = batch[batch.length - 1].id;
    totalCases += batch.length;
    batchNo    += 1;

    for (const tc of batch) {
      const found = scanTestCase(tc);

      for (const { issueKey, field, evidence } of found) {
        // Filter to keys known to exist in jira_issue (FK safety).
        if (!knownJiraKeys.has(issueKey)) {
          if (explain) {
            console.log(
              `  SKIP  ${tc.identityKey} → ${issueKey}` +
              ` (key not in jira_issue)`
            );
          }
          linksSkipped++;
          continue;
        }

        if (dryRun) {
          if (explain) {
            console.log(
              `  [dry] WOULD LINK  ${tc.identityKey} → ${issueKey}` +
              `  field=${field}`
            );
          }
          linksUpserted++;
          continue;
        }

        // Upsert: safe to call repeatedly.
        // @@unique([issueKey, testCaseId, provenance]) means one INFERRED row
        // per (issue, test) pair — EXPLICIT / MANUAL links are unaffected.
        await prisma.jiraAutomationLink.upsert({
          where: {
            issueKey_testCaseId_provenance: {
              issueKey,
              testCaseId: tc.id,
              provenance: "INFERRED",
            },
          },
          create: {
            issueKey,
            testCaseId: tc.id,
            provenance: "INFERRED",
            confidence: "LOW",
            evidence,
            source: "name-inference",
          },
          update: {
            confidence: "LOW",
            evidence,
            source: "name-inference",
          },
        });

        if (explain) {
          console.log(`  LINK  ${tc.identityKey} → ${issueKey}  (${field})`);
        }
        linksUpserted++;
      }
    }

    // Progress ticker every 10 batches.
    if (explain && batchNo % 10 === 0) {
      console.log(
        `[explain] … ${totalCases} cases scanned, ` +
        `${linksUpserted} links so far`
      );
    }
  }

  const dryTag = dryRun ? " [dry-run, no writes]" : "";
  console.log(
    `\nInference scan complete:` +
    `  testCasesScanned=${totalCases}` +
    `  linksUpserted=${linksUpserted}` +
    `  linksSkipped=${linksSkipped}` +
    dryTag
  );

  if (linksSkipped > 0 && !explain) {
    console.log(
      `  (${linksSkipped} key(s) found in test names but not in jira_issue — ` +
      `run etl:sync:jira then re-run with --reset to pick them up)`
    );
  }

  // ── Similarity pass ─────────────────────────────────────────────────────────
  if (!doSimilarity) return;

  console.log(
    `\nRunning title-similarity pass (minScore=${minScore})…`
  );

  // Load all TestCase rows with a non-empty title
  const allTestCases = await prisma.testCase.findMany({
    select: { id: true, identityKey: true, title: true },
    where: { title: { not: "" } },
    orderBy: { id: "asc" },
  });

  // Load Story/Bug/Task Jira issues with a non-empty summary
  const candidateIssues = await prisma.jiraIssue.findMany({
    select: { issueKey: true, summary: true },
    where: {
      issueType: { in: ["Story", "Bug", "Task"] },
      summary:   { not: null },
    },
  });

  if (explain) {
    console.log(
      `[explain] ${allTestCases.length} test cases × ${candidateIssues.length} Jira issues`
    );
  }

  // Pre-tokenise Jira summaries
  const issueTokens = candidateIssues.map((ji) => ({
    issueKey: ji.issueKey,
    tokens:   tokenize(ji.summary ?? ""),
    summary:  ji.summary ?? "",
  }));

  let simLinksUpserted = 0;
  let simLinksSkipped  = 0; // score below threshold

  for (const tc of allTestCases) {
    const tcTokens = tokenize(tc.title);
    if (tcTokens.size === 0) continue;

    // Score against every candidate Jira issue; keep only best match per issue
    const scored = issueTokens
      .map((ji) => ({ ...ji, score: jaccard(tcTokens, ji.tokens) }))
      .filter((ji) => ji.score >= minScore)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      simLinksSkipped++;
      continue;
    }

    for (const match of scored) {
      const confidence = match.score >= 0.40 ? "MED" : "LOW";
      const evidence = `title-similarity score=${match.score.toFixed(3)}: ` +
        `"${tc.title}" ~ "${match.summary}"`;

      if (explain) {
        console.log(
          `  SIM  score=${match.score.toFixed(3)} conf=${confidence}  ` +
          `"${tc.title}" → ${match.issueKey} "${match.summary}"`
        );
      }

      if (!dryRun) {
        await prisma.jiraAutomationLink.upsert({
          where: {
            issueKey_testCaseId_provenance: {
              issueKey:   match.issueKey,
              testCaseId: tc.id,
              provenance: "INFERRED",
            },
          },
          create: {
            issueKey:   match.issueKey,
            testCaseId: tc.id,
            provenance: "INFERRED",
            confidence,
            evidence,
            source: "title-similarity",
          },
          update: { confidence, evidence, source: "title-similarity" },
        });
      }

      simLinksUpserted++;
    }
  }

  console.log(
    `Similarity pass complete:` +
    `  testCasesEvaluated=${allTestCases.length}` +
    `  linksUpserted=${simLinksUpserted}` +
    `  belowThreshold=${simLinksSkipped}` +
    dryTag
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
