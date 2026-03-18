#!/usr/bin/env node
/**
 * upload-to-drop-zone.ts
 *
 * Called from a Jenkins pipeline step (or the simulate-build.sh script)
 * after a CI run completes.  Uploads the result file plus a manifest.json
 * to the Trapeze GCS drop zone so that ingest-from-gcs.ts can process them
 * without needing a direct database connection from the Jenkins agent.
 *
 * This script is intentionally database-free — it only needs GCS credentials.
 * In local dev it routes to fake-gcs-server via GCS_EMULATOR_HOST.
 * In production it uses ADC / Workload Identity against real GCS.
 *
 * Usage (from Jenkins Groovy):
 *   sh """
 *     npx tsx ./scripts/upload-to-drop-zone.ts \\
 *       --file ${WORKSPACE}/test-results.xml \\
 *       --job  ${JOB_NAME} \\
 *       --build ${BUILD_NUMBER} \\
 *       --framework pytest \\
 *       --branch ${GIT_BRANCH} \\
 *       --git-sha ${GIT_COMMIT} \\
 *       --build-url ${BUILD_URL} \\
 *       --environment acceptance
 *   """
 *
 * Usage (manual / simulate-build.sh):
 *   npx tsx ./scripts/upload-to-drop-zone.ts \
 *     --file ./junit_xml/my-results.xml \
 *     --job qa-evite-test-tests-acceptance \
 *     --build 1234 --framework pytest
 *
 * Drop zone path convention:
 *   incoming/{jobName}/{buildNumber}/manifest.json
 *   incoming/{jobName}/{buildNumber}/{resultFilename}
 *
 * Playwright shards — call once per shard, pass --shard-index and --shard-total:
 *   incoming/my-job/456/manifest.json       ← shard 0 manifest
 *   incoming/my-job/456/results-shard0.json
 *   incoming/my-job/456/manifest-shard1.json
 *   incoming/my-job/456/results-shard1.json
 */

import "dotenv/config";

import fs   from "node:fs";
import path from "node:path";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { z } from "zod";

import { uploadFile, uploadBuffer } from "./storage.js";

/** Recursively collect all file paths under a directory. Returns paths relative to base. */
function walkDir(dir: string, base = dir): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full, base));
    } else {
      results.push(path.relative(base, full));
    }
  }
  return results;
}

// ── Manifest schema ───────────────────────────────────────────────────────────
// Keep in sync with ManifestSchema in ingest-from-gcs.ts.

export interface DropZoneManifest {
  schema:      "1";
  jobName:     string;
  buildNumber: number;
  framework:   "pytest" | "playwright" | "junit";
  resultFiles: string[];        // basenames of the uploaded result files
  branch?:     string;
  gitSha?:     string;
  startedAt?:  string;          // ISO-8601
  finishedAt?: string;          // ISO-8601
  environment?: string;
  suiteName?:  string;
  ciProvider:  string;
  buildUrl?:   string;
  shardIndex?: number;
  shardTotal?: number;
  project?:    string;          // Playwright project name (e.g. "chromium")
  artifactFiles?: string[];     // relative paths of uploaded artifacts (under artifacts/ prefix)
}

// ── Args ─────────────────────────────────────────────────────────────────────

const ArgsSchema = z.object({
  file:        z.string().min(1),
  job:         z.string().min(1),
  build:       z.coerce.number().int().nonnegative(),
  framework:   z.enum(["pytest", "playwright", "junit"]),
  branch:      z.string().optional(),
  gitSha:      z.string().optional(),
  startedAt:   z.string().optional(),
  finishedAt:  z.string().optional(),
  environment: z.string().optional(),
  suiteName:   z.string().optional(),
  ciProvider:  z.string().default("jenkins"),
  buildUrl:    z.string().optional(),
  shardIndex:  z.coerce.number().int().optional(),
  shardTotal:  z.coerce.number().int().optional(),
  project:     z.string().optional(),
  artifactsDir: z.string().optional(), // local test-results dir to upload
  dryRun:      z.boolean().default(false),
  explain:     z.boolean().default(false),
});

type Args = z.infer<typeof ArgsSchema>;

async function main() {
  const raw = await yargs(hideBin(process.argv))
    .scriptName("upload-to-drop-zone")
    .usage("$0 --file <path> --job <name> --build <n> --framework <pytest|playwright|junit>")
    .option("file",        { type: "string",  demandOption: true, describe: "Local path to the result file (.xml or .json)" })
    .option("job",         { type: "string",  demandOption: true, describe: "Jenkins job name (used as GCS prefix)" })
    .option("build",       { type: "number",  demandOption: true, describe: "Jenkins build number" })
    .option("framework",   { type: "string",  demandOption: true, choices: ["pytest", "playwright", "junit"], describe: "Test framework" })
    .option("branch",      { type: "string",  describe: "Git branch name" })
    .option("git-sha",     { type: "string",  describe: "Full Git commit SHA" })
    .option("started-at",  { type: "string",  describe: "Build start time (ISO-8601)" })
    .option("finished-at", { type: "string",  describe: "Build finish time (ISO-8601)" })
    .option("environment", { type: "string",  describe: "Test environment (e.g. acceptance, staging)" })
    .option("suite-name",  { type: "string",  describe: "Override suite name" })
    .option("ci-provider", { type: "string",  default: "jenkins", describe: "CI provider name" })
    .option("build-url",   { type: "string",  describe: "Jenkins build URL for traceability" })
    .option("shard-index", { type: "number",  describe: "Playwright shard index (0-based)" })
    .option("shard-total", { type: "number",  describe: "Total number of Playwright shards" })
    .option("project",     { type: "string",  describe: "Playwright project name (e.g. chromium)" })
    .option("artifacts-dir", { type: "string",  describe: "Path to Playwright test-results/ (or pytest artifact output) directory — only failed-test artifacts need be included; contents uploaded to artifacts/ prefix alongside the result file" })
    .option("dry-run",     { type: "boolean", default: false, describe: "Show what would be uploaded without writing to GCS" })
    .option("explain",     { type: "boolean", default: false, describe: "Verbose logging" })
    .help()
    .parse();

  const args: Args = ArgsSchema.parse({
    file:        raw["file"],
    job:         raw["job"],
    build:       raw["build"],
    framework:   raw["framework"],
    branch:      raw["branch"],
    gitSha:      raw["git-sha"],
    startedAt:   raw["started-at"],
    finishedAt:  raw["finished-at"],
    environment: raw["environment"],
    suiteName:   raw["suite-name"],
    ciProvider:  raw["ci-provider"],
    buildUrl:    raw["build-url"],
    shardIndex:  raw["shard-index"],
    shardTotal:  raw["shard-total"],
    project:     raw["project"],
    artifactsDir: raw["artifacts-dir"] as string | undefined,
    dryRun:      raw["dry-run"] as boolean,
    explain:     raw["explain"] as boolean,
  });

  // Validate the source file exists
  if (!fs.existsSync(args.file)) {
    console.error(`Error: result file not found: ${args.file}`);
    process.exit(1);
  }

  const resultBasename = path.basename(args.file);

  // Build the drop zone prefix: incoming/{jobName}/{buildNumber}/
  // For sharded Playwright runs, use a shard suffix on the manifest filename
  // so multiple shards can coexist under the same build prefix.
  const prefix = `incoming/${args.job}/${args.build}`;
  const manifestName = args.shardIndex != null
    ? `manifest-shard${args.shardIndex}.json`
    : `manifest.json`;

  // ── Collect artifact files ────────────────────────────────────────────────
  // Walk the artifacts dir upfront so we can include the file list in the manifest.
  const artifactRelPaths: string[] = [];
  if (args.artifactsDir) {
    if (!fs.existsSync(args.artifactsDir)) {
      console.error(`Error: artifacts dir not found: ${args.artifactsDir}`);
      process.exit(1);
    }
    artifactRelPaths.push(...walkDir(args.artifactsDir));
    if (args.explain) {
      console.log(`Found ${artifactRelPaths.length} artifact file(s) in ${args.artifactsDir}`);
    }
  }

  const manifest: DropZoneManifest = {
    schema:      "1",
    jobName:     args.job,
    buildNumber: args.build,
    framework:   args.framework,
    resultFiles: [resultBasename],
    ciProvider:  args.ciProvider,
    ...(args.branch      && { branch:      args.branch }),
    ...(args.gitSha      && { gitSha:      args.gitSha }),
    ...(args.startedAt   && { startedAt:   args.startedAt }),
    ...(args.finishedAt  && { finishedAt:  args.finishedAt }),
    ...(args.environment && { environment: args.environment }),
    ...(args.suiteName   && { suiteName:   args.suiteName }),
    ...(args.buildUrl    && { buildUrl:    args.buildUrl }),
    ...(args.shardIndex != null && { shardIndex: args.shardIndex }),
    ...(args.shardTotal  != null && { shardTotal: args.shardTotal }),
    ...(args.project          && { project:       args.project }),
    ...(artifactRelPaths.length > 0 && { artifactFiles: artifactRelPaths }),
  };

  const manifestKey  = `${prefix}/${manifestName}`;
  const resultKey    = `${prefix}/${resultBasename}`;
  const manifestJson = JSON.stringify(manifest, null, 2);

  if (args.explain || args.dryRun) {
    const tag = args.dryRun ? "[dry-run] " : "";
    console.log(`${tag}drop zone prefix : ${prefix}/`);
    console.log(`${tag}manifest key     : ${manifestKey}`);
    console.log(`${tag}result key       : ${resultKey}`);
    if (args.explain) {
      console.log(`\nManifest content:\n${manifestJson}`);
    }
  }

  if (args.dryRun) {
    console.log("\nDry run — nothing uploaded.");
    return;
  }

  // Upload manifest first, then result file
  await uploadBuffer(
    Buffer.from(manifestJson, "utf-8"),
    manifestKey,
    "application/json"
  );
  if (args.explain) console.log(`Uploaded manifest → gs://${manifestKey}`);

  const { gcsUri, bytes } = await uploadFile(args.file, resultKey);
  if (args.explain) console.log(`Uploaded result   → ${gcsUri} (${bytes} bytes)`);

  // ── Upload artifact files ─────────────────────────────────────────────────
  let artifactBytes = 0;
  for (const relPath of artifactRelPaths) {
    const localArtPath = path.join(args.artifactsDir!, relPath);
    const artKey       = `${prefix}/artifacts/${relPath}`;
    const { bytes: ab } = await uploadFile(localArtPath, artKey);
    artifactBytes += ab;
    if (args.explain) {
      console.log(`Uploaded artifact → gs://${artKey} (${ab} bytes)`);
    }
  }

  const artifactNote = artifactRelPaths.length > 0
    ? `  artifacts=${artifactRelPaths.length} (${(artifactBytes / 1024).toFixed(1)} KB)`
    : "";
  console.log(`✓  Queued for ingest: ${prefix}/${artifactNote}  [${bytes} bytes result]`);
  console.log(`   Run \`npm run etl:ingest:from-gcs\` to process the drop zone.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
