#!/usr/bin/env node
/**
 * setup-gcs-lifecycle.ts
 *
 * Applies object lifecycle rules to the Trapeze GCS bucket so that
 * large debug artifacts are automatically deleted after their useful life,
 * while small result files (JUnit XML, Playwright JSON) and Postgres metadata
 * are kept indefinitely.
 *
 * Retention tiers
 * ───────────────
 *   screenshots  (image/*)                90 days  builds/.../attachments/
 *   videos       (video/*, .webm, .mp4)   30 days  builds/.../attachments/
 *   traces       (.zip)                   90 days  builds/.../attachments/
 *   stdout/stderr logs (.txt)             90 days  builds/.../attachments/
 *   result files (source/)                ∞        builds/.../source/
 *   drop zone (incoming/processed/failed) ∞        managed by ingest pipeline
 *
 * The DB rows (TestExecution.artifactLinks, RawArtifact.storageUri) outlive
 * the GCS objects.  After expiry the URI becomes a dead link, but the test
 * result metadata — what failed, when, how often — is permanent in Postgres.
 *
 * Usage:
 *   npm run storage:lifecycle          # apply rules (idempotent)
 *   npm run storage:lifecycle -- --show  # print current rules, no changes
 *   npm run storage:lifecycle -- --dry-run  # show what would be applied
 *
 * Note: lifecycle rules are not supported by fake-gcs-server in local dev.
 * This script will print a warning and exit cleanly when GCS_EMULATOR_HOST is set.
 */

import "dotenv/config";

import { Storage } from "@google-cloud/storage";
import { env } from "./env.js";

// ── Lifecycle rules ───────────────────────────────────────────────────────────

const ATTACHMENT_PREFIX = "builds/";   // all artifact objects live here

/**
 * GCS lifecycle rule shape (subset we use).
 * Full spec: https://cloud.google.com/storage/docs/lifecycle
 */
interface LifecycleRule {
  action:    { type: "Delete" };
  condition: {
    age:             number;  // days since object creation
    matchesPrefix?:  string[];
    matchesSuffix?:  string[];
  };
}

const LIFECYCLE_RULES: LifecycleRule[] = [
  // ── Videos (large, short shelf-life) — 30 days ──────────────────────────
  {
    action:    { type: "Delete" },
    condition: {
      age:           30,
      matchesPrefix: [ATTACHMENT_PREFIX],
      matchesSuffix: [".webm", ".mp4", ".mov"],
    },
  },
  // ── Screenshots — 90 days ────────────────────────────────────────────────
  {
    action:    { type: "Delete" },
    condition: {
      age:           90,
      matchesPrefix: [ATTACHMENT_PREFIX],
      matchesSuffix: [".png", ".jpg", ".jpeg", ".webp"],
    },
  },
  // ── Playwright traces — 90 days ───────────────────────────────────────────
  {
    action:    { type: "Delete" },
    condition: {
      age:           90,
      matchesPrefix: [ATTACHMENT_PREFIX],
      matchesSuffix: [".zip"],
    },
  },
  // ── stdout/stderr logs — 90 days ─────────────────────────────────────────
  // Only attachments/ logs (not source/ result files which are also .txt-adjacent)
  {
    action:    { type: "Delete" },
    condition: {
      age:           90,
      matchesPrefix: [`${ATTACHMENT_PREFIX}`, "builds/"],
      matchesSuffix: ["-stdout.txt", "-stderr.txt",
                      "stdout-attempt0.txt", "stdout-attempt1.txt",
                      "stderr-attempt0.txt", "stderr-attempt1.txt"],
    },
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const showOnly = process.argv.includes("--show");
  const dryRun   = process.argv.includes("--dry-run");

  // Lifecycle rules are not supported by fake-gcs-server
  if (env.GCS_EMULATOR_HOST) {
    console.log(
      "[storage:lifecycle] GCS_EMULATOR_HOST is set — fake-gcs-server does not support " +
      "lifecycle rules.\nSkipping (this is expected in local dev).\n" +
      "Run this script against a real GCS bucket in staging/production."
    );
    return;
  }

  const gcs    = new Storage({ projectId: env.GCS_PROJECT });
  const bucket = gcs.bucket(env.GCS_BUCKET);

  // ── Show existing rules ──────────────────────────────────────────────────
  const [metadata] = await bucket.getMetadata();
  const existing   = (metadata.lifecycle?.rule ?? []) as LifecycleRule[];

  if (showOnly) {
    if (existing.length === 0) {
      console.log(`Bucket ${env.GCS_BUCKET} has no lifecycle rules.`);
    } else {
      console.log(`Bucket ${env.GCS_BUCKET} — current lifecycle rules (${existing.length}):`);
      console.log(JSON.stringify(existing, null, 2));
    }
    return;
  }

  // ── Apply rules ──────────────────────────────────────────────────────────
  console.log(`\nApplying ${LIFECYCLE_RULES.length} lifecycle rules to gs://${env.GCS_BUCKET}\n`);

  for (const rule of LIFECYCLE_RULES) {
    const suffixes  = rule.condition.matchesSuffix?.join(", ") ?? "*";
    const prefixes  = rule.condition.matchesPrefix?.join(", ") ?? "*";
    const tag       = dryRun ? "[dry] " : "";
    console.log(`  ${tag}Delete after ${rule.condition.age}d — prefix: ${prefixes}  suffix: ${suffixes}`);
  }

  if (dryRun) {
    console.log("\nDry run — no changes applied.");
    return;
  }

  await bucket.setMetadata({
    lifecycle: { rule: LIFECYCLE_RULES },
  });

  console.log(
    `\n✓  Lifecycle rules applied to gs://${env.GCS_BUCKET}` +
    `\n   GCS will evaluate and enforce these rules daily.` +
    `\n   DB metadata (RawArtifact, TestExecution.artifactLinks) is permanent.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
