# Artifact Storage

Trapeze uploads all test artifacts to Google Cloud Storage (GCS) and stores only
permanent `gs://` URIs in Postgres. This document covers the design, local dev
setup, production GCP configuration, and the one-time migration script.

---

## Design principles

| What | Where | Why |
|------|-------|-----|
| Raw source files (XML, JSON) | GCS | Permanent source of truth; ephemeral on Jenkins workspace |
| Screenshots, videos, Playwright traces | GCS | Binary blobs; too large / not queryable in Postgres |
| stdout / stderr per test attempt | GCS | Debug data; often large; Postgres stores only the pointer |
| Error messages and stack traces | Postgres | Short, queryable text; Metabase can filter and search directly |
| Pass/fail status, duration, hashes | Postgres | Queryable metrics; drive all Metabase dashboards |
| `gs://` URIs | Postgres | Enable retrieval without hitting GCS for every query |

**Nothing is stored twice.** GCS holds the bytes; Postgres holds the metadata and pointers.

---

## GCS key structure

All objects are namespaced under the build ID so a single `gsutil rm -r gs://bucket/builds/{id}/`
cleans up everything for a specific run.

```
gs://{bucket}/
  builds/{buildId}/
    source/
      junit-xml/{filename}.xml           ← raw JUnit XML ingested by ingest-junit.ts
      playwright-json/{filename}.json    ← raw Playwright JSON ingested by ingest-playwright.ts
    attachments/{executionId}/
      screenshot.png                     ← Playwright screenshot attachment
      video.webm                         ← Playwright video attachment
      trace.zip                          ← Playwright trace attachment
      stdout-attempt0.txt                ← stdout from attempt 0 (initial run)
      stderr-attempt0.txt                ← stderr from attempt 0
      stdout-attempt1.txt                ← stdout from attempt 1 (first retry)
      stderr-attempt1.txt                ← etc.
```

`buildId` and `executionId` are Prisma CUIDs (e.g. `clxyz1234…`). Filenames are
the original basenames from the CI workspace — no renaming occurs on upload.

---

## Database fields written

| Table | Field | Value |
|-------|-------|-------|
| `RawArtifact` | `storageUri` | `gs://bucket/builds/{id}/source/…` |
| `TestExecution` | `artifactLinks` | JSON map: `{ "screenshot": "gs://…", "video": "gs://…" }` |
| `TestAttempt` | `logUri` | `gs://…/stdout-attempt{n}.txt` (fast-path for stdout) |
| `BuildLog` | `storageUri` | `gs://…/{stdout|stderr}-attempt{n}.txt` |

`BuildLog` rows enable querying which attempts produced output and how large it was
without fetching the objects from GCS.

---

## Local development — `fake-gcs-server`

The `docker-compose.yml` includes a [`fsouza/fake-gcs-server`](https://github.com/fsouza/fake-gcs-server)
container that runs a GCS-compatible HTTP server locally. The `@google-cloud/storage`
SDK is pointed at it via the `apiEndpoint` constructor option — no code branching
between dev and production.

### Ports and volumes

| Resource | Value |
|----------|-------|
| Container | `test-intel-fake-gcs` |
| Host port | `4443` |
| Data volume | `gcsdata_test_intel` (persists across container restarts) |

### Environment variables for dev

```bash
GCS_BUCKET="test-intel-artifacts"
GCS_PROJECT="test-intel-local"      # any string; unused by the emulator
GCS_EMULATOR_HOST="localhost:4443"  # redirects SDK to fake-gcs-server
```

These are pre-filled in `.env` with local defaults — no changes needed to get started.

### First-time setup

```bash
# Start all containers (Postgres, Metabase, fake-gcs-server)
npm run db:up

# Create the bucket (idempotent — safe to re-run)
npm run storage:bucket
# Output: [storage] Created bucket: test-intel-artifacts
```

### Verifying uploads

After running any ingest script you can inspect the emulator's contents via its
REST API (compatible with the GCS JSON API):

```bash
# List all objects in the bucket
curl -s http://localhost:4443/storage/v1/b/test-intel-artifacts/o | jq '.items[].name'

# Download a specific object
curl -s "http://localhost:4443/storage/v1/b/test-intel-artifacts/o/builds%2F{buildId}%2Fsource%2Fjunit-xml%2Fresults.xml?alt=media"
```

### Resetting the emulator

`npm run db:reset` resets only the Postgres volume. To also wipe GCS artifacts:

```bash
docker compose down
docker volume rm results_gcsdata_test_intel
docker compose up -d
npm run storage:bucket   # re-create the bucket
```

---

## `scripts/storage.ts` — the abstraction layer

All GCS interaction goes through `scripts/storage.ts`. No other script imports
`@google-cloud/storage` directly. This is the single place where dev vs. production
routing is handled.

### Exports

| Export | Signature | Description |
|--------|-----------|-------------|
| `ensureBucket()` | `→ Promise<void>` | Creates the bucket if it doesn't exist. Call once at dev startup; no-op in prod if bucket already exists |
| `uploadFile(localPath, gcsKey)` | `→ Promise<{ gcsUri, bytes }>` | Uploads a file from disk. Uses resumable upload for files > 5 MB |
| `uploadBuffer(buf, gcsKey, contentType?)` | `→ Promise<string>` | Uploads an in-memory Buffer (used for stdout/stderr logs) |
| `signedUrl(gcsUri, expiresMs?)` | `→ Promise<string>` | Generates a time-limited HTTPS URL (default: 15 min). For future Metabase drill-through links |
| `buildKey(buildId, category, filename)` | `→ string` | Builds a canonical GCS object key in the standard structure |
| `parseFileUri(uri)` | `→ string \| null` | Parses a `file://` URI back to a local path. Returns `null` for `gs://` URIs |

### Dev vs. production routing

```typescript
// In scripts/storage.ts — one conditional, no other branching:
if (env.GCS_EMULATOR_HOST) {
  return new Storage({
    projectId:   env.GCS_PROJECT,
    apiEndpoint: `http://${env.GCS_EMULATOR_HOST}`,  // → fake-gcs-server
  });
}
// No GCS_EMULATOR_HOST → uses ADC / Workload Identity → real GCS
return new Storage({ projectId: env.GCS_PROJECT });
```

---

## Production — Google Cloud Setup

### 1. Create the bucket

```bash
gcloud storage buckets create gs://evite-test-intel-artifacts \
  --project=evite-production \
  --location=us-central1 \
  --uniform-bucket-level-access
```

Recommended lifecycle rule to expire old builds (optional):

```bash
gcloud storage buckets update gs://evite-test-intel-artifacts \
  --lifecycle-file=- <<'EOF'
{
  "lifecycle": {
    "rule": [{ "action": { "type": "Delete" }, "condition": { "age": 180 } }]
  }
}
EOF
```

### 2. Service account / Workload Identity

The Jenkins agent needs write access to the bucket. Options:

**Option A — Workload Identity (recommended if Jenkins runs on GKE):**
```bash
gcloud projects add-iam-policy-binding evite-production \
  --member="serviceAccount:jenkins-sa@evite-production.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

**Option B — JSON key (for traditional Jenkins agents):**
```bash
gcloud iam service-accounts keys create jenkins-gcs-key.json \
  --iam-account=jenkins-sa@evite-production.iam.gserviceaccount.com

# Store jenkins-gcs-key.json in Jenkins Credentials (Secret file)
# Reference it in the pipeline as GOOGLE_APPLICATION_CREDENTIALS
```

### 3. Jenkins environment variables

Set these in **Manage Jenkins → System → Global properties → Environment variables**
(or per-pipeline in the `environment {}` block):

| Variable | Value |
|----------|-------|
| `GCS_BUCKET` | `evite-test-intel-artifacts` |
| `GCS_PROJECT` | `evite-production` |

`GCS_EMULATOR_HOST` must **not** be set in Jenkins. Its absence is how the SDK
knows to use real GCS credentials.

### 4. Verify the connection

```bash
# On the Jenkins agent, with service account credentials active:
gcloud auth activate-service-account --key-file=jenkins-gcs-key.json
gcloud storage ls gs://evite-test-intel-artifacts/
```

---

## Migration script — `scripts/migrate-artifacts.ts`

Run once after deploying to back-fill any `RawArtifact` and `TestExecution.artifactLinks`
records that still contain local `file://` paths from before GCS was introduced.

### Usage

```bash
# Dry run — log what would be uploaded and updated; no writes
npm run storage:migrate:dry

# Real run — upload files to GCS and update DB records
npm run storage:migrate

# Process at most 50 records per phase (useful for testing)
npm run storage:migrate -- --limit 50
```

### What it does

**Phase 1 — `RawArtifact` rows:**
- Finds all rows where `storageUri` starts with `file://`
- Checks whether the file still exists on disk
- If found: uploads to `gs://bucket/builds/{buildId}/source/{type}/{filename}` and updates `storageUri`
- If missing: writes `gs://MISSING` as a sentinel (see below)

**Phase 2 — `TestExecution.artifactLinks`:**
- Finds all rows where any `artifactLinks` value is not a `gs://` URI
- For each local path: uploads to `gs://bucket/builds/{buildId}/attachments/{executionId}/{filename}` and rewrites the value
- Missing files get the `gs://MISSING` sentinel

### Missing file sentinel

When a file no longer exists on disk (common for old Jenkins workspace paths that
have already been cleaned), the script writes `gs://MISSING` as the `storageUri`.
This is valid URI syntax and dashboards can filter it with:

```sql
WHERE storage_uri NOT LIKE 'gs://MISSING%'
```

Metabase cards that display artifact links should apply this filter to avoid showing
broken links.

### Idempotency

The script skips any record whose `storageUri` already starts with `gs://`. It is
safe to run multiple times — only `file://` records are touched.

---

## `BuildLog` model

`BuildLog` rows capture per-attempt log blobs. Each row links to a `TestAttempt`
and points to the GCS object containing the actual output.

```prisma
model BuildLog {
  id         String      // CUID
  attemptId  String      // FK → TestAttempt
  logType    String      // "stdout" | "stderr"
  storageUri String      // gs:// URI
  bytes      Int?        // byte size for quick size checks without fetching
  createdAt  DateTime
}
```

`TestAttempt.logUri` is a fast-path field set to the stdout URI for each attempt,
enabling a single DB query to get the most relevant log link without joining
`BuildLog`. `BuildLog` rows provide the full multi-stream picture when needed.

### Why a separate model rather than columns on `TestAttempt`?

Adding new log types (e.g. browser console output, HAR files) requires no schema
change — just a new `BuildLog` row with a different `logType` value. Embedding
everything as columns would require a migration for each new log type.
