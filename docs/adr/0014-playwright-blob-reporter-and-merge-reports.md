# ADR 0014: Playwright Blob Reporter + `merge-reports` for Sharded Runs

- **Date:** 2026-03-24
- **Author:** Joe Peters
- **Status:** Accepted

## Context

Playwright supports `--shard=N/M` to distribute a test suite across multiple parallel runners. A 4-shard run produces four separate result outputs. These must be aggregated before upload to the Trapeze drop zone.

Two aggregation strategies were considered:

**Option A — Upload each shard independently:**

- Each shard uploads its own JSON to GCS immediately when done
- `ingest-from-gcs` processes four separate manifests → four `CiRun` rows
- Pro: no waiting; each shard's results appear in Trapeze as soon as it finishes
- Con: four `CiRun` rows per build; "did the build pass?" requires joining four rows; Metabase KPIs become ambiguous

**Option B — Merge all shards before upload:**

- Each shard uses `--reporter=blob` (produces a `.zip` blob, not a final JSON)
- After all shards finish, `playwright merge-reports --reporter=json,html blob-report/` produces one merged JSON and one HTML report
- Only the merged JSON is uploaded → one `CiRun` row per build
- Pro: unified KPIs; idiomatic Playwright sharding pattern
- Con: ingest waits for all shards to finish

## Decision

**Option B: blob reporter + `merge-reports`.**

All Playwright Jenkinsfiles (both `evite-playwright/scripts/playwright_pipeline.groovy` and `jenkins/Jenkinsfile.playwright-e2e-demo`) use:

1. `--reporter=blob` on each shard
2. Groovy `parallel` stages so shards run concurrently on the same node
3. `playwright merge-reports --reporter=json,html blob-report/ > merged.json` after all shards complete
4. Single upload of `merged.json` to the GCS drop zone

`TestExecution` rows carry `shardIndex` and `shardTotal` for per-shard failure analysis, but they all share the same `CiRun.id`.

## Consequences

**Positive:**

- **Unified KPIs:** one `CiRun` row = one build = one pass/fail signal; no aggregation needed in Metabase
- **Idiomatic:** Playwright's blob reporter is the official mechanism for distributed test aggregation; using it means Trapeze benefits from future Playwright improvements to shard merging
- **Smaller storage:** merged JSON deduplicates suite-level metadata; four separate JSONs would have redundant headers and config sections
- **Single HTML report:** `merge-reports` produces one browsable HTML artifact archived in Jenkins; developers inspect one report, not four
- **Per-shard analysis preserved:** `shardIndex` on `TestExecution` allows "which shard was slowest?" queries without losing the unified build view

**Negative:**

- **Ingest latency:** all shards must complete before results appear in Trapeze; the slowest shard determines the delay
- **Merge step can fail:** if any blob report is corrupted or missing, `merge-reports` fails and no results are uploaded
- **Single-node constraint:** in the current Docker setup, Groovy `parallel` stages share one Jenkins workspace; on distributed agents, blob files would need to be collected to a central location before merging

**Mitigations:**

- `catchError(buildResult: 'FAILURE', stageResult: 'FAILURE')` around the shard stage ensures the merge and upload steps run even when tests fail
- `fileExists("${WORKSPACE}/pw-results/merged.json")` guard in the upload stage prevents a no-op upload if `merge-reports` itself fails
- For distributed agents, a future enhancement could use `stash`/`unstash` to collect blob files to the ETL agent before merging
