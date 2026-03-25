# ADR 0004: Single CiRun per Build, Not per Shard

- **Date:** 2026-03-24
- **Author:** Joe Peters
- **Status:** Accepted

## Context

Playwright supports `--shard=N/M` to split a test suite across multiple parallel runners. A build with `--shard=1/4` through `--shard=4/4` produces four separate result outputs.

Two plausible ingest strategies exist:

**Option A — One CiRun per shard:** Each shard's output is uploaded and ingested independently, producing four `CiRun` rows per build. Simple to implement; no coordination needed between shards.

**Option B — One CiRun per build:** All shards merge their blob reports into a single JSON before upload. One `CiRun` row per build, with `shardIndex` tracked on each `TestExecution`.

## Decision

**Option B: one `CiRun` per build.**

The Jenkins pipeline (and `evite-playwright` Groovy pipeline) runs shards in parallel using `--reporter=blob`. After all shards complete, `playwright merge-reports --reporter=json,html blob-report/ > merged.json` produces a single unified JSON. Only `merged.json` is uploaded to the GCS drop zone. The drain job ingests it as a single `CiRun`.

`TestExecution` tracks `shardIndex` and `shardTotal` so per-shard failure analysis remains possible.

## Consequences

**Positive:**

- Coverage KPIs are unambiguous: one build = one pass/fail signal; no "3/4 shards passed" edge cases in SQL
- Metabase queries are simple: `WHERE runId = ?` returns all tests regardless of which shard ran them
- Merged JSON is smaller than four separate JSONs (suite-level metadata deduplicated by `merge-reports`)
- Single HTML report artifact archived in Jenkins (not four separate reports)
- Idiomatic: Playwright's blob reporter is specifically designed for this aggregation pattern

**Negative:**

- All shards must complete before ingest begins — a hanging shard blocks the entire build's results from appearing in Trapeze
- The ingest pipeline has a hard dependency on the `merge-reports` step succeeding

**Mitigations:**

- Shards run in parallel on the same Jenkins node (Groovy `parallel` stages); total elapsed time ≈ slowest shard, not sum of all shards
- `catchError(buildResult: 'FAILURE', stageResult: 'FAILURE')` around the shard stage lets the merge and upload proceed even when tests fail (results are always uploaded)
- `fileExists("${WORKSPACE}/pw-results/merged.json")` guard in the upload stage prevents a no-op upload if `merge-reports` itself fails
