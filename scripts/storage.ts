/**
 * storage.ts — GCS abstraction layer for artifact uploads and retrieval.
 *
 * All other scripts import from here; nothing else imports @google-cloud/storage directly.
 *
 * Dev:  set GCS_EMULATOR_HOST=localhost:4443  → redirects to fake-gcs-server container
 * Prod: omit GCS_EMULATOR_HOST                → uses ADC / Workload Identity (real GCS)
 */

import { Storage } from "@google-cloud/storage";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env.js";

// ── Client ────────────────────────────────────────────────────────────────────

function makeClient(): Storage {
  if (env.GCS_EMULATOR_HOST) {
    return new Storage({
      projectId:   env.GCS_PROJECT,
      apiEndpoint: `http://${env.GCS_EMULATOR_HOST}`,
    });
  }
  // Production: Application Default Credentials / Workload Identity
  return new Storage({ projectId: env.GCS_PROJECT });
}

const gcs    = makeClient();
const bucket = gcs.bucket(env.GCS_BUCKET);

// ── Bucket management ─────────────────────────────────────────────────────────

/**
 * Ensure the bucket exists. Idempotent — safe to call on every startup in dev.
 * In production the bucket is pre-provisioned by IaC; this call is a no-op
 * if it already exists.
 */
export async function ensureBucket(): Promise<void> {
  const [exists] = await bucket.exists();
  if (!exists) {
    await bucket.create();
    console.log(`[storage] Created bucket: ${env.GCS_BUCKET}`);
  } else {
    console.log(`[storage] Bucket already exists: ${env.GCS_BUCKET}`);
  }
}

// ── Upload helpers ────────────────────────────────────────────────────────────

export interface UploadResult {
  /** Permanent gs:// URI — store this in the database. */
  gcsUri: string;
  /** Byte size of the uploaded object. */
  bytes: number;
}

/**
 * Upload a local file to GCS.
 *
 * @param localPath  Absolute path to the file on disk.
 * @param gcsKey     Destination object path within the bucket
 *                   (e.g. "builds/abc123/source/junit-xml/results.xml").
 * @returns          { gcsUri, bytes }
 */
export async function uploadFile(
  localPath: string,
  gcsKey:    string,
): Promise<UploadResult> {
  const stat = fs.statSync(localPath);
  await bucket.upload(localPath, {
    destination: gcsKey,
    // Use resumable upload only for large files; reduces overhead on small result files.
    resumable: stat.size > 5 * 1024 * 1024,
  });
  return {
    gcsUri: `gs://${env.GCS_BUCKET}/${gcsKey}`,
    bytes:  stat.size,
  };
}

/**
 * Upload an in-memory Buffer directly to GCS.
 * Used for stdout/stderr content that is already in memory — avoids writing a temp file.
 *
 * @param buf          Content to upload.
 * @param gcsKey       Destination object path within the bucket.
 * @param contentType  MIME type (defaults to plain text UTF-8).
 * @returns            Permanent gs:// URI.
 */
export async function uploadBuffer(
  buf:         Buffer,
  gcsKey:      string,
  contentType  = "text/plain; charset=utf-8",
): Promise<string> {
  const file = bucket.file(gcsKey);
  await file.save(buf, { contentType });
  return `gs://${env.GCS_BUCKET}/${gcsKey}`;
}

// ── Retrieval ─────────────────────────────────────────────────────────────────

/**
 * Generate a time-limited signed URL for a GCS object.
 * Use this when you need to serve a direct download link (e.g. from Metabase drill-through).
 * Do NOT store signed URLs in the database — they expire.
 *
 * @param gcsUri    Permanent gs:// URI (as stored in the DB).
 * @param expiresMs Expiry duration in milliseconds (default: 15 minutes).
 * @returns         HTTPS signed URL valid for the specified duration.
 */
export async function signedUrl(
  gcsUri:    string,
  expiresMs: number = 15 * 60 * 1000,
): Promise<string> {
  const key = gcsUri.replace(`gs://${env.GCS_BUCKET}/`, "");
  const [url] = await bucket.file(key).getSignedUrl({
    version: "v4",
    action:  "read",
    expires: Date.now() + expiresMs,
  });
  return url;
}

// ── Key builder ───────────────────────────────────────────────────────────────

/** Valid category strings for the canonical GCS key structure. */
export type GcsCategory =
  | "source/junit-xml"
  | "source/playwright-json"
  | `attachments/${string}`;

/**
 * Build a canonical GCS object key.
 *
 * Key structure:
 *   builds/{buildId}/source/junit-xml/{filename}
 *   builds/{buildId}/source/playwright-json/{filename}
 *   builds/{buildId}/attachments/{executionId}/{filename}
 *
 * @param buildId   Build ID (Prisma CUID).
 * @param category  One of the GcsCategory union literals.
 * @param filename  Basename of the file (path.basename safe).
 */
export function buildKey(
  buildId:  string,
  category: GcsCategory,
  filename: string,
): string {
  return `builds/${buildId}/${category}/${path.basename(filename)}`;
}

// ── Object management (used by drop-zone ingest) ──────────────────────────────

/**
 * List all object keys (relative paths within the bucket) under a GCS prefix.
 * Returns an empty array if no objects match.
 *
 * @param prefix  Object prefix to filter by (e.g. "incoming/").
 */
export async function listObjects(prefix: string): Promise<string[]> {
  const [files] = await bucket.getFiles({ prefix });
  return files.map((f) => f.name);
}

/**
 * Download a GCS object into an in-memory Buffer.
 *
 * @param gcsKey  Object key within the bucket (no gs:// prefix).
 */
export async function downloadToBuffer(gcsKey: string): Promise<Buffer> {
  const [contents] = await bucket.file(gcsKey).download();
  return contents;
}

/**
 * Copy an object within the same bucket.
 *
 * @param srcKey  Source object key.
 * @param dstKey  Destination object key.
 */
export async function copyObject(srcKey: string, dstKey: string): Promise<void> {
  await bucket.file(srcKey).copy(bucket.file(dstKey));
}

/**
 * Delete an object from the bucket.
 *
 * @param gcsKey  Object key to delete.
 */
export async function deleteObject(gcsKey: string): Promise<void> {
  await bucket.file(gcsKey).delete({ ignoreNotFound: true });
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Parse a file:// URI back to an absolute local path.
 * Returns null if the URI is not a file:// URI (e.g. already a gs:// URI).
 */
export function parseFileUri(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  return uri.slice("file://".length);
}

// ── CLI entry point ───────────────────────────────────────────────────────────
// Driven by: npm run storage:bucket  →  tsx ./scripts/storage.ts --create-bucket

if (process.argv.includes("--create-bucket")) {
  ensureBucket()
    .then(() => console.log("[storage:bucket] Done."))
    .catch((e) => {
      console.error("[storage:bucket] Error:", e);
      process.exit(1);
    });
}
