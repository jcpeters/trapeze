# ADR 0003: GCS Drop Zone with Child Process Ingest

- **Date:** 2026-03-24
- **Author:** Joe Peters
- **Status:** Accepted

## Context

Test execution happens on CI agents across many environments (developer laptops, ephemeral GitHub Actions runners, on-premise Jenkins agents). These agents run user-controlled code (test suites) and must not hold database credentials.

A naive approach — having CI agents insert test results directly into Postgres — creates several problems:

- Every test agent needs database credentials (credential sprawl; blast radius if one agent is compromised)
- Agents must stay alive until the database write completes (slow network, connection pooling issues)
- A crash in one batch's ingest could silently drop results

The ingest scripts (`ingest-junit.ts`, `ingest-playwright.ts`) are stateful and complex. Running them inside the drain loop (as imported modules) means a crash in one batch's parsing code would throw an uncaught exception, aborting the entire drain and leaving the remaining manifests unprocessed.

## Decision

**Two-tier architecture:**

1. **CI agents (write-only):** Upload result files + a `manifest.json` to `gs://bucket/incoming/{job}/{build}/`. No database access. Credentials: a limited-scope GCS service account with `storage.objects.create` only.

2. **Trapeze ETL agent (drain job):** The `trapeze-ingest-from-gcs` Jenkins job runs on a `trapeze`-labelled agent. It:
   - Discovers manifests under `incoming/**`
   - Spawns `ingest-junit.ts` or `ingest-playwright.ts` as **child processes** (via `spawnSync`) per batch
   - On success: moves batch to `processed/YYYY-MM-DD/{job}/{build}/`
   - On failure: moves batch to `failed/YYYY-MM-DD/{job}/{build}/` with a captured `error.txt`

Child processes are used instead of dynamic `import()` so that a crash (uncaught exception, OOM, stack overflow) in one batch's parsing code is contained to that child process. The drain loop continues to the next manifest.

## Consequences

**Positive:**

- Principle of least privilege: CI agents hold write-only GCS credentials; zero database exposure
- Failure isolation: a malformed XML or database deadlock in one batch cannot abort the drain loop
- Idempotent retry: `processed/` and `failed/` directories serve as an audit trail; re-running the drain job on `failed/` batches is safe (upserts deduplicate)
- Observable: `failed/YYYY-MM-DD/.../error.txt` contains the full stack trace for debugging
- Scalable: multiple drain job instances can process separate manifests concurrently without locking

**Negative:**

- Network latency: manifest and result files are downloaded by the drain agent (extra round-trip vs. direct DB write from CI)
- Temporary disk usage on the ETL agent for downloaded files (cleaned up in `finally` block)
- Manifest schema versioning required — evolving the manifest format requires backward-compatible changes or a version field

**Mitigations:**

- Playwright pipelines use `merge-reports` before upload, so only one merged JSON is downloaded per build (not one per shard)
- ETL agent has ample local disk (Jenkins workspace); cleanup is guaranteed by `finally` block
- Manifest `version` field reserved for future format evolution
