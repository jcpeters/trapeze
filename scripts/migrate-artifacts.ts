#!/usr/bin/env node
/**
 * migrate-artifacts.ts — Back-fill existing file:// artifact records to GCS.
 *
 * Run once after storage.ts is deployed to migrate any RawArtifact rows and
 * TestExecution.artifactLinks maps that still contain local file:// paths.
 *
 * Usage:
 *   npm run storage:migrate:dry   # dry-run: log what would change, no writes
 *   npm run storage:migrate       # real run: upload files, update DB
 *
 * Flags:
 *   --dry-run        Log only — no uploads, no DB writes.
 *   --limit <n>      Process at most n records per phase (default: all).
 *
 * Idempotent: records already containing gs:// URIs are skipped.
 * Missing files: written as gs://MISSING (sentinel) so dashboards can filter.
 */

import "dotenv/config";

import fs   from "node:fs";
import path from "node:path";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { prisma }                          from "./db/prisma.js";
import { uploadFile, buildKey, ensureBucket } from "./storage.js";
import { env }                             from "./env.js";

// Sentinel written when a file no longer exists on disk.
// Valid URI syntax so parsers don't crash, but clearly not a real GCS path.
const SENTINEL = "gs://MISSING";

// ── CLI ───────────────────────────────────────────────────────────────────────

const argv = await yargs(hideBin(process.argv))
  .scriptName("migrate-artifacts")
  .usage("$0 [--dry-run] [--limit <n>]")
  .option("dry-run", {
    type:     "boolean",
    default:  false,
    describe: "Log what would change without writing anything",
  })
  .option("limit", {
    type:     "number",
    default:  0,
    describe: "Max records to process per phase (0 = all)",
  })
  .strict()
  .parseAsync();

const dryRun = argv["dry-run"] as boolean;
const limit  = argv.limit as number;

// ── Phase 1: RawArtifact rows with file:// URIs ───────────────────────────────

async function migrateRawArtifacts(): Promise<void> {
  const query = {
    where:  { storageUri: { startsWith: "file://" } },
    select: { id: true, buildId: true, artifactType: true, storageUri: true },
    ...(limit > 0 ? { take: limit } : {}),
  } as const;

  const rows = await prisma.rawArtifact.findMany(query);
  console.log(`\n[Phase 1] RawArtifact: ${rows.length} file:// records found`);

  let migrated = 0, missing = 0, skipped = 0;

  for (const row of rows) {
    const localPath = row.storageUri.replace(/^file:\/\//, "");

    if (dryRun) {
      console.log(`  [dry]  ${row.id}  ${localPath}`);
      skipped++;
      continue;
    }

    if (!fs.existsSync(localPath)) {
      console.warn(`  [miss] ${row.id}  ${localPath}`);
      await prisma.rawArtifact.update({
        where: { id: row.id },
        data:  { storageUri: SENTINEL },
      });
      missing++;
      continue;
    }

    try {
      const category =
        row.artifactType === "junit-xml"
          ? ("source/junit-xml" as const)
          : ("source/playwright-json" as const);

      const gcsKey         = buildKey(row.buildId, category, path.basename(localPath));
      const { gcsUri }     = await uploadFile(localPath, gcsKey);

      await prisma.rawArtifact.update({
        where: { id: row.id },
        data:  { storageUri: gcsUri },
      });

      console.log(`  [ok]   ${row.id}  →  ${gcsUri}`);
      migrated++;
    } catch (err) {
      console.error(`  [err]  ${row.id}`, err);
    }
  }

  console.log(
    `[Phase 1] Done. migrated=${migrated}  missing=${missing}  skipped=${skipped}`,
  );
}

// ── Phase 2: TestExecution.artifactLinks with local paths ────────────────────

async function migrateArtifactLinks(): Promise<void> {
  // TestExecution has no direct buildId — traverse through CiRun.
  // Fetch rows; filter to non-null artifactLinks in code to avoid
  // Prisma Json null-filter typing quirks with nullable Json fields.
  const allRows = await prisma.testExecution.findMany({
    select: {
      id:            true,
      artifactLinks: true,
      runId:         true,
    },
    ...(limit > 0 ? { take: limit } : undefined),
  });

  // Resolve buildId for each row via CiRun
  const runIds  = [...new Set(allRows.map((r) => r.runId))];
  const ciRuns  = await prisma.ciRun.findMany({
    where:  { id: { in: runIds } },
    select: { id: true, buildId: true },
  });
  const buildIdByRunId = new Map(ciRuns.map((r) => [r.id, r.buildId]));

  const rows = allRows.map((r) => ({
    ...r,
    buildId: buildIdByRunId.get(r.runId) ?? "unknown",
  }));

  // Filter to only rows that have at least one non-gs:// value.
  const toMigrate = rows.filter((r) => {
    const links = r.artifactLinks as Record<string, string> | null;
    return links && Object.values(links).some((v) => !v.startsWith("gs://"));
  });

  console.log(
    `\n[Phase 2] TestExecution.artifactLinks: ${toMigrate.length} records with local paths`,
  );

  let migrated = 0;

  for (const exec of toMigrate) {
    const links   = exec.artifactLinks as Record<string, string>;
    const buildId = exec.buildId;

    if (dryRun) {
      console.log(`  [dry]  execution=${exec.id}`, links);
      continue;
    }

    const updated: Record<string, string> = {};
    let changed = false;

    for (const [key, rawPath] of Object.entries(links)) {
      // Already a gs:// URI — leave unchanged.
      if (rawPath.startsWith("gs://")) {
        updated[key] = rawPath;
        continue;
      }

      const localPath = rawPath.startsWith("file://")
        ? rawPath.slice("file://".length)
        : rawPath;

      if (!fs.existsSync(localPath)) {
        console.warn(`  [miss] exec=${exec.id}  key=${key}  ${localPath}`);
        updated[key] = SENTINEL;
        changed = true;
        continue;
      }

      try {
        const gcsKey     = buildKey(buildId, `attachments/${exec.id}`, path.basename(localPath));
        const { gcsUri } = await uploadFile(localPath, gcsKey);
        updated[key]     = gcsUri;
        changed = true;
        console.log(`  [ok]   exec=${exec.id}  key=${key}  →  ${gcsUri}`);
      } catch (err) {
        console.error(`  [err]  exec=${exec.id}  key=${key}`, err);
        updated[key] = rawPath; // leave unchanged on error; can retry
      }
    }

    if (changed) {
      await prisma.testExecution.update({
        where: { id: exec.id },
        data:  { artifactLinks: updated },
      });
      migrated++;
    }
  }

  console.log(`[Phase 2] Done. migrated=${migrated}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (dryRun) {
    console.log("=== DRY RUN — no uploads or DB writes will occur ===\n");
  } else {
    console.log(`Bucket: gs://${env.GCS_BUCKET}`);
    if (env.GCS_EMULATOR_HOST) {
      console.log(`Emulator: http://${env.GCS_EMULATOR_HOST}`);
    }
    await ensureBucket();
  }

  await migrateRawArtifacts();
  await migrateArtifactLinks();

  console.log("\n[migrate-artifacts] Complete.");
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
