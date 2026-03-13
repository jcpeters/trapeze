#!/usr/bin/env node
/**
 * infer-jira-links.ts
 *
 * Scans TestCase.identityKey, TestCase.title, and TestCase.suiteName for
 * embedded Jira issue keys (e.g. QAA-123) and writes jira_automation_link
 * rows with:
 *
 *   provenance = INFERRED
 *   confidence = LOW
 *   source     = "name-inference"
 *
 * This is intentionally conservative:
 *  - Never touches existing EXPLICIT or MANUAL links (different provenance row).
 *  - Only links to keys that already exist in jira_issue (FK safety).
 *  - Confidence is LOW because name-matching is purely heuristic.
 *  - Safe to re-run — upserts on (issueKey, testCaseId, provenance=INFERRED).
 *
 * Typical workflow:
 *   1. npm run etl:sync:jira          # populate jira_issue first
 *   2. npm run etl:ingest:junit       # populate test_case rows
 *   3. npm run etl:infer:jira         # write inferred links
 *
 * Usage:
 *   npm run etl:infer:jira
 *   npm run etl:infer:jira -- --dry-run
 *   npm run etl:infer:jira -- --explain
 *   npm run etl:infer:jira -- --batch-size 200 --explain
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
    .help()
    .parse();

  const batchSize  = argv["batch-size"]  as number;
  const dryRun     = argv["dry-run"]     as boolean;
  const explain    = argv["explain"]     as boolean;
  const doReset    = argv["reset"]       as boolean;

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
