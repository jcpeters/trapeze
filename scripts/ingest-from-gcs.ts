#!/usr/bin/env node
/**
 * ingest-from-gcs.ts  —  GCS Drop Zone Drainer
 *
 * Scans the Trapeze GCS drop zone for result files uploaded by Jenkins
 * (or simulate-build.sh) and ingests each batch into Postgres without
 * requiring the CI pipeline to have direct database access.
 *
 * Flow:
 *   1. List  incoming/{jobName}/{buildNumber}/manifest.json  objects
 *   2. For each batch:
 *        a. Parse manifest.json to recover build metadata
 *        b. Download result file(s) to a temp directory
 *        c. Shell out to ingest-junit.ts or ingest-playwright.ts
 *        d. On success → copy prefix to processed/YYYY-MM-DD/…  + delete from incoming/
 *        e. On failure → copy prefix to failed/YYYY-MM-DD/…,
 *                        write error.txt, delete from incoming/
 *   3. Optionally reprocess files already in failed/ (--reprocess-failed)
 *
 * Idempotent: processed batches are moved out of incoming/ so the same
 * manifest will never be ingested twice unless explicitly reprocessed.
 *
 * Usage:
 *   npm run etl:ingest:from-gcs
 *   npm run etl:ingest:from-gcs -- --dry-run
 *   npm run etl:ingest:from-gcs -- --explain --limit 5
 *   npm run etl:ingest:from-gcs -- --reprocess-failed
 *
 * Environment:
 *   DATABASE_URL       — Postgres connection string (read by child ingest scripts)
 *   GCS_BUCKET         — Bucket name
 *   GCS_EMULATOR_HOST  — Set to fake-gcs host in dev; omit for real GCS
 *
 * Scheduling:
 *   Run this script on any host with DATABASE_URL access — developer machine
 *   via launchd/cron, Cloud Run job (triggered or scheduled), or a Jenkins
 *   "drain" pipeline that runs on a build agent with DB access.
 */

import "dotenv/config";

import fs   from "node:fs";
import os   from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { z } from "zod";

import { listObjects, downloadToBuffer, copyObject, deleteObject, uploadBuffer } from "./storage.js";

// ── Manifest schema ───────────────────────────────────────────────────────────

const ManifestSchema = z.object({
  schema:      z.literal("1"),
  jobName:     z.string().min(1),
  buildNumber: z.coerce.number().int(),
  framework:   z.enum(["pytest", "playwright", "junit"]),
  resultFiles: z.array(z.string()).min(1),
  branch:      z.string().optional(),
  gitSha:      z.string().optional(),
  startedAt:   z.string().optional(),
  finishedAt:  z.string().optional(),
  environment: z.string().optional(),
  suiteName:   z.string().optional(),
  ciProvider:  z.string().default("jenkins"),
  buildUrl:    z.string().optional(),
  shardIndex:    z.number().optional(),
  shardTotal:    z.number().optional(),
  project:       z.string().optional(),
  artifactFiles: z.array(z.string()).optional().default([]), // relative paths under artifacts/ prefix
});

type Manifest = z.infer<typeof ManifestSchema>;

// ── Constants ─────────────────────────────────────────────────────────────────

const INCOMING_PREFIX  = "incoming/";
const PROCESSED_PREFIX = "processed/";
const FAILED_PREFIX    = "failed/";
const MANIFEST_GLOB    = /\/manifest(-shard\d+)?\.json$/;

// tsx binary path (avoids relying on PATH; tsx is a dev dep)
const TSX_BIN = path.join(process.cwd(), "node_modules", ".bin", "tsx");

// ── CLI args ──────────────────────────────────────────────────────────────────

async function parseArgs() {
  return yargs(hideBin(process.argv))
    .scriptName("ingest-from-gcs")
    .usage("$0 [options]\n\nDrain the GCS drop zone into Postgres.")
    .option("dry-run", {
      alias:   "n",
      type:    "boolean",
      default: false,
      describe: "Scan and report without ingesting or moving files",
    })
    .option("explain", {
      type:    "boolean",
      default: false,
      describe: "Verbose per-batch logging",
    })
    .option("limit", {
      type:    "number",
      describe: "Maximum number of batches to process in this run",
    })
    .option("reprocess-failed", {
      type:    "boolean",
      default: false,
      describe: "Also re-attempt batches in failed/ (in addition to incoming/)",
    })
    .option("prefix", {
      type:    "string",
      default: INCOMING_PREFIX,
      describe: "Override the GCS scan prefix (for testing specific paths)",
    })
    .help()
    .parse();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Date string in YYYY-MM-DD format for archiving. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Derive the archive prefix for a processed or failed batch. */
function archivePrefix(
  status:   "processed" | "failed",
  jobName:  string,
  buildNumber: number,
  shardIndex?: number,
): string {
  const shard = shardIndex != null ? `-shard${shardIndex}` : "";
  return `${status}/${today()}/${jobName}/${buildNumber}${shard}/`;
}

/** Find all manifest keys in the given prefix. */
async function findManifests(prefix: string): Promise<string[]> {
  const keys = await listObjects(prefix);
  return keys.filter((k) => MANIFEST_GLOB.test(k));
}

/** Download a GCS object and write it to a local temp path. */
async function downloadToFile(gcsKey: string, localPath: string): Promise<void> {
  const buf = await downloadToBuffer(gcsKey);
  fs.writeFileSync(localPath, buf);
}

/** Move all objects under srcPrefix to dstPrefix, then delete originals. */
async function movePrefix(srcPrefix: string, dstPrefix: string): Promise<void> {
  const keys = await listObjects(srcPrefix);
  for (const key of keys) {
    const relative = key.slice(srcPrefix.length);
    await copyObject(key, `${dstPrefix}${relative}`);
    await deleteObject(key);
  }
}

// ── Ingest dispatch ───────────────────────────────────────────────────────────

/**
 * Build the CLI args array for the appropriate ingest script.
 * Maps manifest fields to the flag names each script understands.
 *
 * @param artifactsLocalDir  Optional local dir where artifact files have been
 *   downloaded from GCS — passed as --artifacts-dir to ingest-playwright.ts
 *   so it can resolve CI-machine absolute paths to locally available files.
 */
function buildIngestArgs(
  manifest:         Manifest,
  resultLocalPath:  string,
  artifactsLocalDir?: string,
): { script: string; args: string[] } {
  const isPlaywright = manifest.framework === "playwright";
  const script = isPlaywright
    ? "./scripts/ingest-playwright.ts"
    : "./scripts/ingest-junit.ts";

  const args: string[] = [];

  if (isPlaywright) {
    // ingest-playwright.ts uses kebab-case flags; no positional arg.
    args.push("--json-path", resultLocalPath);
    args.push("--job",   manifest.jobName);
    args.push("--build", String(manifest.buildNumber));
    if (manifest.branch)           args.push("--branch",        manifest.branch);
    if (manifest.gitSha)           args.push("--git-sha",       manifest.gitSha);
    if (manifest.environment)      args.push("--environment",   manifest.environment);
    if (manifest.buildUrl)         args.push("--build-url",     manifest.buildUrl);
    if (manifest.ciProvider)       args.push("--ci",            manifest.ciProvider);
    if (manifest.shardIndex != null) args.push("--shard-index", String(manifest.shardIndex));
    if (manifest.shardTotal  != null) args.push("--shard-total", String(manifest.shardTotal));
    if (manifest.project)          args.push("--project",       manifest.project);
    if (artifactsLocalDir)         args.push("--artifacts-dir", artifactsLocalDir);
    // Note: ingest-playwright.ts has no --started-at flag; start time is
    // derived from the JSON reporter's startTime field.
  } else {
    // ingest-junit.ts uses camelCase flags and a positional junitPath arg.
    args.push(resultLocalPath);                          // positional junitPath
    args.push("--job",   manifest.jobName);
    args.push("--build", String(manifest.buildNumber)); // --build, not --build-number
    if (manifest.framework)   args.push("--framework",  manifest.framework);
    if (manifest.suiteName)   args.push("--suite",      manifest.suiteName);   // --suite
    if (manifest.branch)      args.push("--branch",     manifest.branch);
    if (manifest.gitSha)      args.push("--gitSha",     manifest.gitSha);      // camelCase
    if (manifest.environment) args.push("--environment", manifest.environment);
    if (manifest.buildUrl)    args.push("--buildUrl",   manifest.buildUrl);    // camelCase
    if (manifest.ciProvider)  args.push("--ci",         manifest.ciProvider);  // --ci
    if (manifest.startedAt)   args.push("--startedAt",  manifest.startedAt);  // camelCase
  }

  return { script, args };
}

// ── Batch processing ──────────────────────────────────────────────────────────

interface BatchResult {
  manifestKey: string;
  status: "ok" | "failed" | "dry";
  errorMessage?: string;
  ingested: number; // number of result files ingested
}

async function processBatch(
  manifestKey: string,
  options: { dryRun: boolean; explain: boolean },
): Promise<BatchResult> {
  const { dryRun, explain } = options;

  // ── Parse the batch prefix from the manifest key ──────────────────────────
  // e.g. "incoming/my-job/1234/manifest.json" → "incoming/my-job/1234/"
  const batchPrefix = manifestKey.slice(0, manifestKey.lastIndexOf("/") + 1);

  // Parse manifest
  let manifest: Manifest;
  try {
    const buf  = await downloadToBuffer(manifestKey);
    const json = JSON.parse(buf.toString("utf-8"));
    manifest   = ManifestSchema.parse(json);
  } catch (err) {
    return {
      manifestKey,
      status: "failed",
      errorMessage: `manifest parse error: ${(err as Error).message}`,
      ingested: 0,
    };
  }

  if (explain) {
    console.log(`  batch: ${batchPrefix}`);
    console.log(`    job=${manifest.jobName}  build=${manifest.buildNumber}  framework=${manifest.framework}`);
    if (manifest.branch) console.log(`    branch=${manifest.branch}`);
    if (manifest.shardIndex != null) console.log(`    shard=${manifest.shardIndex}/${manifest.shardTotal}`);
  }

  if (dryRun) {
    console.log(`  [dry] would ingest ${manifest.resultFiles.length} file(s) from ${batchPrefix}`);
    return { manifestKey, status: "dry", ingested: 0 };
  }

  // ── Create temp directory ─────────────────────────────────────────────────
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trapeze-ingest-"));

  try {
    let ingested = 0;

    // ── Download artifact files (screenshots, traces, videos) ─────────────
    // These are referenced by absolute CI-machine paths inside the JSON/XML.
    // Downloading them to tmpDir/artifacts/ lets --artifacts-dir resolve them.
    let artifactsLocalDir: string | undefined;
    if (manifest.artifactFiles && manifest.artifactFiles.length > 0) {
      artifactsLocalDir = path.join(tmpDir, "artifacts");
      fs.mkdirSync(artifactsLocalDir, { recursive: true });

      if (explain) {
        console.log(`    downloading ${manifest.artifactFiles.length} artifact file(s)…`);
      }

      for (const relPath of manifest.artifactFiles) {
        const srcKey   = `${batchPrefix}artifacts/${relPath}`;
        const localArt = path.join(artifactsLocalDir, relPath);
        fs.mkdirSync(path.dirname(localArt), { recursive: true });
        try {
          await downloadToFile(srcKey, localArt);
        } catch (err) {
          // Non-fatal: warn and continue — the ingest script will skip missing attachments
          console.warn(`    [warn] artifact not found in GCS, skipping: ${srcKey}`);
        }
      }
    }

    for (const resultFile of manifest.resultFiles) {
      const srcKey     = `${batchPrefix}${resultFile}`;
      const localPath  = path.join(tmpDir, resultFile);

      // Download result file to tmp
      try {
        await downloadToFile(srcKey, localPath);
      } catch (err) {
        throw new Error(`failed to download ${srcKey}: ${(err as Error).message}`);
      }

      // Build and run ingest command
      const { script, args } = buildIngestArgs(manifest, localPath, artifactsLocalDir);

      if (explain) {
        console.log(`    → tsx ${script} ${args.join(" ")}`);
      }

      const result = spawnSync(TSX_BIN, [script, ...args], {
        stdio:    ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
        env:      { ...process.env }, // propagate DATABASE_URL, GCS_* etc.
      });

      if (result.status !== 0) {
        const errOut = [result.stdout, result.stderr].filter(Boolean).join("\n");
        throw new Error(
          `ingest script exited with code ${result.status}:\n${errOut.slice(0, 2000)}`
        );
      }

      if (explain && result.stdout) {
        // Print ingest script's summary line(s)
        result.stdout.trim().split("\n").slice(-3).forEach((l) => console.log(`      ${l}`));
      }

      ingested++;
    }

    // ── Move batch to processed/ ──────────────────────────────────────────
    const dst = archivePrefix("processed", manifest.jobName, manifest.buildNumber, manifest.shardIndex);
    await movePrefix(batchPrefix, dst);

    if (explain) console.log(`    ✓ archived → ${dst}`);

    return { manifestKey, status: "ok", ingested };

  } catch (err) {
    // ── Move batch to failed/ and write error.txt ─────────────────────────
    const errorMsg = (err as Error).message;
    const dst = archivePrefix("failed", manifest.jobName, manifest.buildNumber, manifest.shardIndex);

    try {
      await movePrefix(batchPrefix, dst);
      await uploadBuffer(
        Buffer.from(`${new Date().toISOString()}\n\n${errorMsg}`, "utf-8"),
        `${dst}error.txt`,
        "text/plain"
      );
    } catch (archiveErr) {
      console.error(`  Warning: failed to archive error batch to ${dst}:`, archiveErr);
    }

    return { manifestKey, status: "failed", errorMessage: errorMsg, ingested: 0 };

  } finally {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = await parseArgs();

  const dryRun           = argv["dry-run"]          as boolean;
  const explain          = argv["explain"]           as boolean;
  const limit            = argv["limit"]             as number | undefined;
  const reprocessFailed  = argv["reprocess-failed"]  as boolean;
  const prefix           = argv["prefix"]            as string;

  console.log(`\nTrapeze drop zone drainer${dryRun ? "  [dry-run]" : ""}\n`);

  // ── Discover pending batches ───────────────────────────────────────────────

  const manifests: string[] = [];
  manifests.push(...await findManifests(prefix));

  if (reprocessFailed) {
    const failedManifests = await findManifests(FAILED_PREFIX);
    manifests.push(...failedManifests);
    if (explain && failedManifests.length > 0) {
      console.log(`Found ${failedManifests.length} batch(es) in failed/ to reprocess.`);
    }
  }

  if (manifests.length === 0) {
    console.log("No pending batches in drop zone.");
    return;
  }

  const batches = limit ? manifests.slice(0, limit) : manifests;
  console.log(`Found ${manifests.length} pending batch(es)${limit ? ` — processing ${batches.length}` : ""}\n`);

  // ── Process each batch ─────────────────────────────────────────────────────

  let ok = 0, failed = 0, dry = 0;
  const failures: { key: string; error: string }[] = [];

  for (const manifestKey of batches) {
    const batchLabel = manifestKey
      .replace(/^(incoming|failed)\//, "")
      .replace(/\/manifest(-shard\d+)?\.json$/, "");

    process.stdout.write(`  ${batchLabel}  …`);

    const result = await processBatch(manifestKey, { dryRun, explain });

    if (result.status === "ok") {
      console.log(`  ✓ (${result.ingested} file(s) ingested)`);
      ok++;
    } else if (result.status === "dry") {
      console.log("  (dry)");
      dry++;
    } else {
      console.log(`  ✗ FAILED`);
      console.error(`    ${result.errorMessage?.split("\n")[0]}`);
      failures.push({ key: manifestKey, error: result.errorMessage ?? "(unknown)" });
      failed++;
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  const dryTag = dryRun ? "  [dry-run — no writes]" : "";
  console.log(`\nDone:  ok=${ok}  failed=${failed}${dryRun ? `  dry=${dry}` : ""}${dryTag}`);

  if (manifests.length > batches.length) {
    console.log(
      `Note: ${manifests.length - batches.length} batch(es) not processed this run.` +
      ` Run again or increase --limit.`
    );
  }

  if (failures.length > 0) {
    console.error("\nFailed batches (now in failed/ for investigation):");
    for (const f of failures) {
      console.error(`  ${f.key}`);
      console.error(`    ${f.error.split("\n")[0]}`);
    }
    console.error("\nRe-run with --reprocess-failed after fixing the root cause.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
