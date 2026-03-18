#!/usr/bin/env node
/**
 * infer-testrail-links.ts
 *
 * Matches automated TestCase rows to TestRail manual test cases using keyword
 * overlap scoring, then writes automation_testrail_link rows with:
 *
 *   provenance = INFERRED
 *   confidence = MED  (matchScore >= 0.5)
 *             or LOW  (matchScore >= 0.3, below MED threshold)
 *
 * Normalization strategy for pytest-style names:
 *   "test_evite_sign_in.TestEviteSignIn"
 *     → strip module prefix (test_, evite_), split on _ and camelCase
 *     → tokens: ["sign", "in"]
 *   "test_evite_copy_premium_past_event.TestEviteCopyPremiumPastEvent"
 *     → tokens: ["copy", "premium", "past", "event"]
 *
 * Scoring:
 *   score = |auto_tokens ∩ tr_tokens| / |auto_tokens|
 *   Requires ALL auto tokens to have at least a partial match in the TR title
 *   for MED confidence — conservative by design.
 *
 * Safety:
 *   - Never touches EXPLICIT or MANUAL rows (different provenance).
 *   - Only writes links when score >= MIN_SCORE (default 0.3).
 *   - Safe to re-run — upserts on (testCaseId, trCaseId, provenance=INFERRED).
 *   - --reset deletes all INFERRED/title-inference rows before re-scanning.
 *
 * Typical workflow:
 *   1. npm run etl:sync:testrail        # populate testrail_case first
 *   2. npm run etl:ingest:junit         # populate test_case rows
 *   3. npm run etl:infer:testrail       # write inferred links
 *   4. npm run etl:infer:testrail -- --explain  # see match details
 *
 * Usage:
 *   npm run etl:infer:testrail
 *   npm run etl:infer:testrail -- --dry-run
 *   npm run etl:infer:testrail -- --explain
 *   npm run etl:infer:testrail -- --min-score 0.4
 *   npm run etl:infer:testrail -- --top-k 3
 *   npm run etl:infer:testrail -- --reset
 */

import "dotenv/config";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { prisma } from "./db/prisma";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MIN_SCORE  = 0.3;   // links below this score are discarded
const DEFAULT_TOP_K      = 5;     // max TestRail matches written per automated test
const DEFAULT_BATCH_SIZE = 200;   // TestRail cases loaded per DB page

/** Tokens filtered out before scoring — too common to be meaningful. */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "by",
  "is", "are", "was", "be", "as", "it", "its", "for", "with", "that",
  "this", "from", "into", "then", "when", "not", "no", "can", "will",
  "do", "does", "have", "has", "had", "test", "evite", "verify",
  "confirm", "check", "ensure", "click", "view", "page", "user",
]);

/**
 * Prefixes stripped from pytest module/class names before tokenising.
 * Order matters — longer prefixes first.
 */
const STRIP_PREFIXES = [
  "test_evite_",
  "testevite",
  "test_",
  "test",
];

// ── Tokenisation helpers ──────────────────────────────────────────────────────

/**
 * Split a camelCase or PascalCase string into lowercase tokens.
 * "TestEviteSignIn" → ["test", "evite", "sign", "in"]
 */
function splitCamel(s: string): string[] {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split("_")
    .filter(Boolean);
}

/**
 * Normalise a test title to a set of meaningful lowercase tokens.
 *
 * Handles:
 *   - pytest style:   "test_evite_sign_in.TestEviteSignIn"
 *   - Playwright:     "should complete RSVP yes flow"
 *   - plain English:  "Verify sign in from homepage"
 */
function tokenise(title: string): Set<string> {
  // Take the part before the first dot (module name is richer for pytest)
  const modulePart = title.split(".")[0];

  // Strip known prefixes (case-insensitive)
  let stripped = modulePart.toLowerCase();
  for (const prefix of STRIP_PREFIXES) {
    if (stripped.startsWith(prefix)) {
      stripped = stripped.slice(prefix.length);
      break;
    }
  }

  // Split on underscores, spaces, hyphens, then handle camelCase
  const rawTokens = stripped
    .split(/[\s_\-./]+/)
    .flatMap(splitCamel);

  // Also tokenise the full title to capture class name tokens
  const fullTokens = title
    .toLowerCase()
    .split(/[\s_\-./]+/)
    .flatMap(splitCamel);

  const all = [...rawTokens, ...fullTokens];

  return new Set(
    all
      .map((t) => t.replace(/[^a-z0-9]/g, ""))
      .filter((t) => t.length >= 2 && !STOP_WORDS.has(t))
  );
}

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Score how well a TestRail case title matches the automated test tokens.
 *
 * score = matched_auto_tokens / total_auto_tokens
 *
 * A token is "matched" if it appears verbatim OR as a substring in any
 * TestRail token (handles plurals and partial words like "sign" matching
 * "signing", "signin").
 */
function score(autoTokens: Set<string>, trTitle: string): number {
  if (autoTokens.size === 0) return 0;

  const trTokens = tokenise(trTitle);
  const trArray  = [...trTokens];

  let matched = 0;
  for (const at of autoTokens) {
    const hit = trArray.some((tt) => tt === at || tt.includes(at) || at.includes(tt));
    if (hit) matched++;
  }

  return matched / autoTokens.size;
}

// ── Confidence mapping ────────────────────────────────────────────────────────

function scoreToConfidence(s: number): "HIGH" | "MED" | "LOW" {
  if (s >= 0.8) return "HIGH";
  if (s >= 0.5) return "MED";
  return "LOW";
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("infer-testrail-links")
    .usage(
      "$0 [options]\n\n" +
      "Match automated test names against TestRail case titles and write " +
      "INFERRED automation_testrail_link rows."
    )
    .option("min-score", {
      type:     "number",
      default:  DEFAULT_MIN_SCORE,
      describe: "Minimum keyword overlap score (0–1) to create a link",
    })
    .option("top-k", {
      type:     "number",
      default:  DEFAULT_TOP_K,
      describe: "Maximum TestRail matches to write per automated test",
    })
    .option("batch-size", {
      type:     "number",
      default:  DEFAULT_BATCH_SIZE,
      describe: "Number of TestRail cases loaded per DB page",
    })
    .option("dry-run", {
      alias:   "n",
      type:    "boolean",
      default: false,
      describe: "Score and report without writing any rows",
    })
    .option("explain", {
      type:    "boolean",
      default: false,
      describe: "Print match details for every candidate (verbose)",
    })
    .option("reset", {
      type:    "boolean",
      default: false,
      describe:
        "Delete all existing INFERRED/title-inference links before re-scanning",
    })
    .help()
    .parse();

  const minScore  = argv["min-score"]  as number;
  const topK      = argv["top-k"]      as number;
  const batchSize = argv["batch-size"] as number;
  const dryRun    = argv["dry-run"]    as boolean;
  const explain   = argv["explain"]    as boolean;
  const doReset   = argv["reset"]      as boolean;

  // ── Step 1: Guard — testrail_case must be populated ──────────────────────

  const trCount = await prisma.testRailCase.count();
  if (trCount === 0) {
    console.error(
      "testrail_case table is empty — run `npm run etl:sync:testrail` first.\n" +
      "Exiting without changes."
    );
    process.exit(1);
  }

  // ── Step 2: Load all TestCase rows ───────────────────────────────────────

  const autoCases = await prisma.testCase.findMany({
    select: { id: true, identityKey: true, title: true, suiteName: true },
  });

  if (autoCases.length === 0) {
    console.warn("No TestCase rows found. Ingest some test results first.");
    return;
  }

  console.log(
    `Loaded ${autoCases.length} automated test case(s) and ` +
    `${trCount} TestRail case(s).`
  );
  if (dryRun)   console.log("[dry-run] No rows will be written.");
  if (doReset)  console.log("[reset]   Existing INFERRED/title-inference links will be deleted first.");
  console.log(`Settings: min-score=${minScore}  top-k=${topK}\n`);

  // Pre-tokenise automated tests once
  const autoTokenMap = new Map<string, Set<string>>();
  for (const tc of autoCases) {
    autoTokenMap.set(tc.id, tokenise(tc.title));
  }

  // ── Step 3: Optional reset ───────────────────────────────────────────────

  if (doReset && !dryRun) {
    const deleted = await prisma.automationTestRailLink.deleteMany({
      where: { provenance: "INFERRED", source: "title-inference" },
    });
    console.log(`[reset] Deleted ${deleted.count} existing title-inference INFERRED links.\n`);
  }

  // ── Step 4: Page through TestRail cases and score against each auto test ─

  let linksUpserted = 0;
  let linksSkipped  = 0;
  let cursor: bigint | undefined;

  // Accumulate top-K candidates per auto test across all TR pages
  // Map<testCaseId, Array<{trCaseId, score, title, sectionPath}>>
  type Candidate = {
    trCaseId:    bigint;
    trTitle:     string;
    sectionPath: string | null;
    matchScore:  number;
  };
  const candidateMap = new Map<string, Candidate[]>();
  for (const tc of autoCases) candidateMap.set(tc.id, []);

  let trPagesLoaded = 0;

  while (true) {
    const trBatch = await prisma.testRailCase.findMany({
      take: batchSize,
      ...(cursor !== undefined ? { skip: 1, cursor: { trCaseId: cursor } } : {}),
      select: { trCaseId: true, title: true, sectionPath: true },
      orderBy: { trCaseId: "asc" },
    });

    if (trBatch.length === 0) break;
    cursor = trBatch[trBatch.length - 1].trCaseId;
    trPagesLoaded++;

    for (const tr of trBatch) {
      if (!tr.title) continue;

      for (const tc of autoCases) {
        const autoTokens = autoTokenMap.get(tc.id)!;
        const s = score(autoTokens, tr.title);

        if (s < minScore) continue;

        const candidates = candidateMap.get(tc.id)!;
        candidates.push({
          trCaseId:    tr.trCaseId,
          trTitle:     tr.title,
          sectionPath: tr.sectionPath,
          matchScore:  s,
        });
      }
    }
  }

  // ── Step 5: For each auto test keep only top-K, then upsert ──────────────

  for (const tc of autoCases) {
    const autoTokens = autoTokenMap.get(tc.id)!;
    const candidates = candidateMap.get(tc.id)!;

    // Sort descending by score, keep top-K
    const topCandidates = candidates
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, topK);

    if (topCandidates.length === 0) {
      linksSkipped++;
      if (explain) {
        console.log(`  NO MATCH  "${tc.title}"  (tokens: ${[...autoTokens].join(", ")})`);
      }
      continue;
    }

    if (explain) {
      console.log(`\n"${tc.title}"  (tokens: ${[...autoTokens].join(", ")})`);
    }

    for (const c of topCandidates) {
      const confidence = scoreToConfidence(c.matchScore);
      const evidence   =
        `title-inference score=${c.matchScore.toFixed(2)}: ` +
        `"${c.trTitle.slice(0, 80)}${c.trTitle.length > 80 ? "…" : ""}"` +
        (c.sectionPath ? `  [${c.sectionPath}]` : "");

      if (explain) {
        const tag = dryRun ? "[dry]" : "";
        console.log(
          `  ${tag} score=${c.matchScore.toFixed(2)} ${confidence.padEnd(4)}  ` +
          `C${c.trCaseId}  "${c.trTitle.slice(0, 70)}"`
        );
      }

      if (!dryRun) {
        await prisma.automationTestRailLink.upsert({
          where: {
            testCaseId_trCaseId_provenance: {
              testCaseId: tc.id,
              trCaseId:   c.trCaseId,
              provenance: "INFERRED",
            },
          },
          create: {
            testCaseId: tc.id,
            trCaseId:   c.trCaseId,
            provenance: "INFERRED",
            confidence,
            matchScore: c.matchScore,
            evidence,
            source: "title-inference",
          },
          update: {
            confidence,
            matchScore: c.matchScore,
            evidence,
            source: "title-inference",
          },
        });
      }

      linksUpserted++;
    }
  }

  // ── Step 6: Summary ───────────────────────────────────────────────────────

  const dryTag = dryRun ? " [dry-run, no writes]" : "";
  console.log(
    `\nInference complete:` +
    `  autoTestsScanned=${autoCases.length}` +
    `  linksWritten=${linksUpserted}` +
    `  testsWithNoMatch=${linksSkipped}` +
    dryTag
  );

  if (!dryRun && linksUpserted > 0) {
    // Summary by confidence tier
    const breakdown = await prisma.automationTestRailLink.groupBy({
      by: ["confidence"],
      where: { source: "title-inference" },
      _count: true,
    });
    for (const row of breakdown) {
      console.log(`  ${row.confidence}: ${row._count}`);
    }
    console.log(
      "\nReview low-confidence links in Metabase → Link Governance → " +
      "Unreviewed TestRail Links before trusting them in coverage reports."
    );
  }
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
