# Test Intelligence Platform (Trapeze)

A self-contained data platform for tracking test results, coverage, flakes, and Jira linkage across Selenium and Playwright CI runs.

**Stack:** Postgres 16 (Docker) · Prisma · TypeScript scripts · Metabase dashboards · Google Cloud Storage (GCS)

**Repo:** `git@github.com:jcpeters/trapeze.git` _(pending transfer to `evite` org — once an org admin creates `evite/trapeze`, update remote with `git remote set-url origin git@github.com:evite/trapeze.git && git push -u origin main`)_

**Local path:** `/Users/joe.peters/Development/results`

---

## Status & known gaps

| Area                                                         | Status                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Schema + migrations                                          | ✅ Complete (9 migrations)                                                                                                                                                                                                                                                           |
| JUnit ingest (Selenium/pytest)                               | ✅ Complete                                                                                                                                                                                                                                                                          |
| Playwright ingest (JSON reporter, sharding, @tag Jira links) | ✅ Complete                                                                                                                                                                                                                                                                          |
| Jira sync                                                    | ✅ Complete                                                                                                                                                                                                                                                                          |
| TestRail sync                                                | ✅ Complete                                                                                                                                                                                                                                                                          |
| Jira link inference (text-match)                             | ✅ Complete                                                                                                                                                                                                                                                                          |
| Flake detection                                              | ✅ Complete                                                                                                                                                                                                                                                                          |
| Coverage snapshots                                           | ✅ Complete                                                                                                                                                                                                                                                                          |
| 20 SQL analytics views                                       | ✅ Complete                                                                                                                                                                                                                                                                          |
| Metabase dashboards (3 dashboards, 19 cards)                 | ✅ Complete                                                                                                                                                                                                                                                                          |
| Playwright Jenkins pipeline                                  | ✅ Complete (`evite-playwright/scripts/playwright_pipeline.groovy`)                                                                                                                                                                                                                  |
| **GCS artifact storage**                                     | ✅ Complete — source files, attachments, and stdout/stderr uploaded to GCS; local dev uses `fake-gcs-server`                                                                                                                                                                         |
| **Automated → TestRail mapping**                             | ✅ Complete — `automation_testrail_link` table, title-inference script, `@C1234` tag extraction in Playwright, `<property name="testrail.case">` extraction in JUnit                                                                                                                 |
| **Jira ↔ TestRail link inference**                           | ✅ Complete (`etl:infer:jira-testrail`)                                                                                                                                                                                                                                              |
| **Feature-area coverage epics**                              | ✅ Complete — 14 Jira epics (QAA-659–QAA-672) created as coverage anchors; 29 MANUAL/HIGH `jira_automation_link` rows map all 29 regression tests to their feature area                                                                                                              |
| **GCS Drop Zone (CI → Trapeze bridge)**                      | ✅ Complete — `upload-to-drop-zone.ts` (Jenkins step, DB-free), `ingest-from-gcs.ts` (drainer), `simulate-build.sh` (local test harness), `jenkins/Jenkinsfile.trapeze-ingest` (reusable Groovy). Jenkins uploads result files to GCS; drainer runs on any host with `DATABASE_URL`. |
| **Local Jenkins (dev/test)**                                 | ✅ Complete — `docker compose --profile jenkins up` starts Jenkins LTS + Node.js 20 on the Docker network; reaches `postgres:5432` and `fake-gcs:4443` directly.                                                                                                                     |
| **Scheduled / cron job wiring**                              | ✅ Complete — all ETL Jenkinsfiles have cron triggers (ingest-from-gcs every 15 min; sync-jira, sync-testrail, snapshot-coverage, analyze-flakes daily)                                                                                                                              |
| **TestRail push (DB → TestRail)**                            | ✅ Complete — `push-testrail-results.ts` creates TestRail test runs from ingested Playwright results; links via `automation_testrail_link`; `etl:push:testrail` npm script; `Jenkinsfile.push-testrail` pipeline                                                                     |
| **Slack failure alerts**                                     | ✅ Complete — `vars/trapezeSlackNotify.groovy` shared library step used in all ETL Jenkinsfiles; requires `trapeze-slack-webhook-url` Jenkins credential (optional — degrades gracefully)                                                                                            |
| **Production deployment**                                    | 📋 Planned — [`docs/production-deployment.md`](docs/production-deployment.md) is the complete deployment blueprint (Cloud SQL, Cloud Run for Metabase, GCS, Secret Manager, IAM); not yet deployed                                                                                   |

**Next task for a new agent:** Deploy to production following [`docs/production-deployment.md`](docs/production-deployment.md). All ETL pipelines and schedules are complete locally; production requires Cloud SQL, GCS buckets, and a Jenkins ETL agent with the `trapeze` label configured on the production farm.

---

## Architecture

```
  Jira Cloud ──── sync-jira.ts ──────────────────────────┐
  TestRail ─────── sync-testrail.ts (read) ───────────────┤
           ◄─────── push-testrail-results.ts (write) ──────┤
  JUnit XML ──── ingest-junit.ts ─────────────────────────┤──► GCS (source files,
  Playwright JSON ─ ingest-playwright.ts ─────────────────┤    attachments, logs)
                                                           │         │
                                                           ├──► Postgres (metadata + gs:// URIs) ──► SQL views ──► Metabase
                                                           │
  infer-jira-links.ts ──────── (test→jira text-match) ───┤
  infer-jira-testrail-links.ts  (TR↔jira bridge+sim) ────┤
  detect-flakes.ts ────── (rolling-window flake math) ────┤
  snapshot-coverage.ts ── (KPI time-series row) ──────────┘
```

**Storage design principle:** GCS holds the bytes (raw XML/JSON source files, screenshots, videos, Playwright traces, stdout/stderr logs). Postgres holds queryable metadata and permanent `gs://` URIs. Stack traces and error messages stay in the DB as they are short, queryable text. Nothing is stored twice.

---

## CI Pipeline → Trapeze: GCS Drop Zone

The ingest scripts require `DATABASE_URL`, but the Jenkins farm cannot reach a developer's local Postgres. The **drop zone** pattern decouples the two sides:

```
Jenkins agent (no DB access needed)
  └─ upload-to-drop-zone.ts ──► gs://bucket/incoming/{job}/{build}/manifest.json
                                                                   /results.xml

Any host with DATABASE_URL (dev machine, Cloud Run job, Jenkins drain pipeline)
  └─ ingest-from-gcs.ts ──► downloads from incoming/
                          ──► calls ingest-junit.ts or ingest-playwright.ts
                          ──► moves batch to processed/ or failed/
```

### Jenkins pipeline step (add to existing Jenkinsfile)

```groovy
post {
  always {
    // Groovy helper defined in jenkins/Jenkinsfile.trapeze-ingest
    trapezePushResults(
      framework:   'pytest',
      resultFile:  "${WORKSPACE}/test-output/results.xml",
      environment: 'acceptance'
    )
  }
}
```

Required Jenkins credentials: `trapeze-gcs-bucket`, `trapeze-gcs-project`, `trapeze-gcs-sa-key`.

### Test the drop zone locally (no Jenkins needed)

```bash
# 1. Upload a result file to the local fake-gcs drop zone
./scripts/simulate-build.sh junit_xml/my-results.xml \
    --job qa-evite-test-tests-acceptance --build 9999 \
    --framework pytest --environment acceptance

# 2. Drain the drop zone into Postgres
npm run etl:ingest:from-gcs -- --explain
```

### Local Jenkins (optional — for validating Groovy pipeline syntax)

```bash
# Start Jenkins + its dependencies on the Docker network
docker compose --profile jenkins up -d

# Open Jenkins UI
open http://localhost:8080   # admin / trapeze-local
```

Jenkins can reach `postgres:5432` and `fake-gcs:4443` directly via Docker networking.
The production Jenkins farm points at the same GCS bucket — swap credentials only.

**Local development:** `docker-compose.yml` includes a `fake-gcs-server` container at `localhost:4443` that is fully compatible with the `@google-cloud/storage` SDK. Set `GCS_EMULATOR_HOST=localhost:4443` in `.env` to redirect all GCS calls to it. Remove the variable entirely to use real GCS.

---

## Prereqs

- Docker
- Node.js 18+
- Google Cloud SDK (`gcloud`) — **only required for production**; local dev uses the `fake-gcs-server` container instead

---

## Quick start

```bash
# 1. Fill in credentials — .env already exists with local defaults;
#    add your Jira/TestRail API tokens as needed.
#    GCS vars are pre-filled for local dev (fake-gcs-server).
#    (do NOT commit .env — it is gitignored)

# 2. Install dependencies
npm install

# 3. Start Postgres + Metabase + fake-gcs-server
npm run db:up

# 4. Run migrations
npm run db:migrate

# 5. Create the GCS bucket in fake-gcs-server
npm run storage:bucket

# 6. Apply SQL analytics views
npm run db:views

# 7. (Optional) seed sample data
npm run db:seed

# 8. (Optional) set up Metabase dashboards
npm run mb:setup
```

| Service            | URL                                                            |
| ------------------ | -------------------------------------------------------------- |
| Postgres           | `postgresql://test_intel:test_intel@localhost:5432/test_intel` |
| Metabase           | http://localhost:3000                                          |
| GCS emulator (dev) | http://localhost:4443                                          |

> **Note:** `npm run storage:bucket` creates the `test-intel-artifacts` bucket inside the local `fake-gcs-server` container. This is a one-time step per fresh Docker volume; it is a no-op if the bucket already exists.

---

## Reset the database

```bash
npm run db:down       # stop containers
npm run db:reset      # drop + recreate Postgres volume (destructive)
npm run db:up
npm run db:migrate
npm run storage:bucket   # re-create the GCS bucket (new volume = empty emulator)
npm run db:views
npm run db:seed
```

> **GCS emulator note:** `db:reset` only resets the Postgres volume. The `gcsdata_test_intel` Docker volume persists independently. To also wipe GCS artifacts: `docker volume rm results_gcsdata_test_intel` before `db:up`.

---

## NPM scripts reference

### Database

| Script        | Description                                                         |
| ------------- | ------------------------------------------------------------------- |
| `db:up`       | Start Postgres + Metabase via Docker Compose                        |
| `db:down`     | Stop containers                                                     |
| `db:reset`    | Drop and recreate the Postgres volume (destructive)                 |
| `db:migrate`  | Run Prisma migrations                                               |
| `db:generate` | Regenerate Prisma client after schema changes                       |
| `db:seed`     | Insert sample Jira issues, test cases, and CI runs                  |
| `db:views`    | Apply all SQL analytics views from `scripts/sql/coverage-views.sql` |

### ETL — Ingest

| Script                  | Description                                                                                                                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `etl:ingest:junit`      | Ingest a JUnit XML file (Selenium / pytest runs) — direct, requires `DATABASE_URL`                                                                                                                                                                             |
| `etl:ingest:playwright` | Ingest a Playwright JSON reporter output file — direct, requires `DATABASE_URL`                                                                                                                                                                                |
| `etl:ingest:from-gcs`   | **Drop zone drainer** — scan `incoming/` in GCS, download result files, call the appropriate ingest script per batch, archive to `processed/` or `failed/`. Run on any host with `DATABASE_URL` access (developer machine, Cloud Run, Jenkins drain pipeline). |
| `etl:upload:drop-zone`  | **Drop zone uploader** — upload one result file + a manifest.json to `gs://bucket/incoming/{job}/{build}/`. Database-free; suitable for Jenkins pipeline steps.                                                                                                |

### ETL — Sync

| Script                    | Description                                                                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `etl:sync:jira`           | Pull Jira issues into `jira_issue` table                                                                                                                                                                 |
| `etl:sync:testrail`       | Pull TestRail test cases and results into DB (read-only)                                                                                                                                                 |
| `etl:push:testrail`       | Push ingested Playwright results from DB → TestRail as a new Test Run. Resolves test cases via `automation_testrail_link`. Use `--dry-run` to preview.                                                   |
| `etl:infer:jira`          | Text-match test titles against Jira issues to create `jira_automation_link` rows                                                                                                                         |
| `etl:infer:testrail`      | Keyword-overlap match automated test titles against TestRail case titles to create `automation_testrail_link` rows                                                                                       |
| `etl:infer:jira-testrail` | Infer `jira_testrail_link` rows via automation bridge + title similarity                                                                                                                                 |
| `etl:seed:coverage-epics` | Create 14 feature-area Jira epics (QAA-659–QAA-672) as coverage anchors and link all regression tests to them via MANUAL/HIGH `jira_automation_link` rows. Idempotent — reuses epics that already exist. |
| `etl:seed:sync-demo`      | Seed 12 Jira issues + 18 TestRail cases + 24 results for testing the inference pipeline end-to-end. Pass `--teardown` to remove seeded rows.                                                             |
| `etl:snapshot:coverage`   | Write one `coverage_snapshot` row from current `v_executed_coverage_summary` values                                                                                                                      |

### Analysis

| Script           | Description                                                     |
| ---------------- | --------------------------------------------------------------- |
| `analyze:flakes` | Run rolling-window flake detection; write `flake_decision` rows |

### Artifact storage (GCS)

| Script                | Description                                                                             |
| --------------------- | --------------------------------------------------------------------------------------- |
| `storage:bucket`      | Create the GCS bucket (idempotent). Required once after `db:up` in dev; no-op in prod   |
| `storage:migrate:dry` | Dry-run: show which `file://` DB records would be uploaded to GCS — no changes made     |
| `storage:migrate`     | Upload any remaining `file://` artifact records to GCS and update their URIs to `gs://` |

### Metabase

| Script     | Description                                                             |
| ---------- | ----------------------------------------------------------------------- |
| `mb:setup` | Create/update Metabase DB connection, questions, and dashboards via API |

### Code quality

| Script   | Description                                |
| -------- | ------------------------------------------ |
| `lint`   | Run ESLint across all TypeScript scripts   |
| `format` | Run Prettier (write mode) across all files |

---

## ETL scripts — detailed reference

All scripts accept `--dry-run` (validate without writing) and `--explain` (verbose output).

### `etl:ingest:junit`

Ingests a JUnit XML file produced by pytest or Selenium into `Build`, `CiRun`, `TestCase`, `TestExecution`, and `JiraAutomationLink`.

**Required args:**

| Flag      | Description           |
| --------- | --------------------- |
| `--job`   | Jenkins job full name |
| `--build` | Build number          |

**Optional args:**

| Flag                             | Description                                                  |
| -------------------------------- | ------------------------------------------------------------ |
| `--ci`                           | CI provider (default: `jenkins`)                             |
| `--suite`                        | Suite name override                                          |
| `--framework`                    | Framework label (`pytest`, `playwright`, etc.)               |
| `--build-url`                    | Link back to the CI build                                    |
| `--git-sha`                      | Git commit SHA                                               |
| `--branch`                       | Branch name                                                  |
| `--environment`                  | Target environment                                           |
| `--started-at` / `--finished-at` | ISO timestamps                                               |
| `--jira-property-names`          | Comma-separated `<property>` names to extract Jira keys from |
| `--skip-jira-links`              | Skip writing `jira_automation_link` rows                     |

**Example:**

```bash
npm run etl:ingest:junit -- \
  ./sample/junit-build101.xml \
  --job "qa-tests-version-acceptance" \
  --build 101 \
  --branch main \
  --environment prod \
  --git-sha abc123
```

---

### `etl:ingest:playwright`

Ingests a Playwright JSON reporter output (`npx playwright test --reporter=json`) into `Build`, `CiRun`, `TestExecution`, `TestAttempt` (one per retry), and `JiraAutomationLink` (from `@tag` annotations).

**Required args:**

| Flag          | Description                      |
| ------------- | -------------------------------- |
| `--json-path` | Path to the Playwright JSON file |
| `--job`       | CI job full name                 |
| `--build`     | Build number                     |

**Optional args:**

| Flag                | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `--ci`              | CI provider (default: `jenkins`)                      |
| `--build-url`       | Link back to the CI build                             |
| `--git-sha`         | Git commit SHA                                        |
| `--branch`          | Branch name                                           |
| `--environment`     | Target environment                                    |
| `--pr-number`       | Pull request number                                   |
| `--shard-index`     | 1-based shard index (omit if not sharding)            |
| `--shard-total`     | Total number of shards                                |
| `--project`         | Filter to a single Playwright project name            |
| `--skip-jira-links` | Skip writing `jira_automation_link` rows from `@tags` |

**Examples:**

```bash
# Single run
npm run etl:ingest:playwright -- \
  --json-path ./pw-results.json \
  --job "playwright-acceptance" \
  --build 42 \
  --branch main \
  --environment prod

# Sharded run (shard 2 of 4)
npm run etl:ingest:playwright -- \
  --json-path ./pw-results/shard-2-of-4.json \
  --job "playwright-acceptance" \
  --build 42 \
  --shard-index 2 \
  --shard-total 4 \
  --project acceptance
```

**Jira link extraction from `@tags`:**
Any test tag matching a Jira key pattern (`@QAA-123`, `QAA-123`, or a full Jira URL) creates a `jira_automation_link` row with `confidence=HIGH, provenance=EXPLICIT`. Use `--skip-jira-links` to disable.

---

### `etl:sync:jira`

Fetches Jira issues from the Jira Cloud REST API v3 and upserts them into `jira_issue`.

**Env vars required:**

```
JIRA_BASE_URL=https://yourorg.atlassian.net
JIRA_EMAIL=service-account@yourorg.com
JIRA_API_TOKEN=your-atlassian-api-token
```

**Key flags:**

| Flag              | Description                                                                           |
| ----------------- | ------------------------------------------------------------------------------------- |
| `--projects`      | Comma-separated project keys (e.g. `QAA,PROJ`). Falls back to `JIRA_PROJECTS` env var |
| `--issue-types`   | Filter by issue type (default: `Story,Bug,Task`)                                      |
| `--updated-after` | ISO date — only sync issues updated after this date                                   |
| `--full-sync`     | Ignore `updated-after`; fetch all issues                                              |
| `--page-size`     | API page size (default: 100)                                                          |

**Example:**

```bash
npm run etl:sync:jira -- --projects QAA,PROJ --updated-after 2024-01-01
```

---

### `etl:sync:testrail`

Two-phase sync: pulls TestRail test cases (into `test_rail_case`) and run results (into `test_rail_result`).

**Env vars required:**

```
TESTRAIL_BASE_URL=https://yourorg.testrail.io
TESTRAIL_EMAIL=service-account@yourorg.com
TESTRAIL_API_TOKEN=your-testrail-api-key
```

**Key flags:**

| Flag              | Description                                                                        |
| ----------------- | ---------------------------------------------------------------------------------- |
| `--project-ids`   | Comma-separated TestRail project IDs. Falls back to `TESTRAIL_PROJECT_IDS` env var |
| `--suite-ids`     | Limit to specific suite IDs                                                        |
| `--skip-cases`    | Skip test case sync                                                                |
| `--skip-results`  | Skip test result sync                                                              |
| `--full-sync`     | Ignore incremental cutoff                                                          |
| `--updated-after` | ISO date for incremental sync                                                      |
| `--batch-size`    | API batch size (default: 250)                                                      |

**Example:**

```bash
npm run etl:sync:testrail -- --project-ids 1,2
```

---

### `etl:push:testrail`

Reads `TestExecution` rows from the Trapeze DB and creates a TestRail Test Run with results. This is the **write-direction** counterpart to `etl:sync:testrail` (which reads FROM TestRail).

Links are resolved via the `automation_testrail_link` table (populated by `etl:infer:testrail` and `@C1234` annotations in Playwright tests).

**Env vars required:**

```
TESTRAIL_BASE_URL=https://yourorg.testrail.io
TESTRAIL_EMAIL=service-account@yourorg.com
TESTRAIL_API_TOKEN=your-testrail-api-key
TESTRAIL_PROJECT_ID=1
DATABASE_URL=...
```

**Status mapping:**

| Trapeze status | TestRail status |
| -------------- | --------------- |
| PASSED         | 1 (Passed)      |
| FAILED         | 5 (Failed)      |
| FLAKY          | 4 (Retest)      |
| SKIPPED        | 3 (Untested)    |
| ERROR          | 5 (Failed)      |

**Selection modes:**

| Flag                  | Description                                 |
| --------------------- | ------------------------------------------- |
| `--ci-run-id ID`      | Push a specific CiRun                       |
| `--job JOB --build N` | Select by Jenkins job name + build number   |
| `--since DATE`        | Push all CiRuns since ISO date (batch mode) |

**Optional flags:**

| Flag                              | Description                                                 |
| --------------------------------- | ----------------------------------------------------------- |
| `--project-id N`                  | Override TestRail project (fallback: `TESTRAIL_PROJECT_ID`) |
| `--suite-id N`                    | Restrict to a specific TestRail suite                       |
| `--min-confidence HIGH\|MED\|LOW` | Link quality threshold (default: MED)                       |
| `--run-name TEXT`                 | Custom TestRail run name                                    |
| `--close-run`                     | Close the run after adding results                          |
| `--dry-run`                       | Preview without writing                                     |
| `--explain`                       | Verbose logging                                             |

**Examples:**

```bash
# Preview a specific build
npm run etl:push:testrail -- --job "playwright-acceptance" --build 42 --dry-run

# Push and close the run
npm run etl:push:testrail -- --ci-run-id 7 --close-run

# Batch push everything since a date
npm run etl:push:testrail -- --since 2026-04-01
```

Each invocation creates a **new** TestRail run — safe to re-run; previous runs are not overwritten. Use `--dry-run` to preview which cases would be included.

**Annotation-based case linking:** Playwright tests can use `test.info().annotations` with `type: 'TestRail'` and `description: 'C1234'` to create EXPLICIT links. These take precedence over inferred links.

---

### `etl:infer:jira`

Scans `TestCase.identityKey`, `title`, and `suiteName` for Jira key patterns and writes `jira_automation_link` rows with `confidence=MEDIUM, provenance=INFERRED`. Safe to re-run; skips rows that already exist.

**Key flags:**

| Flag           | Description                                   |
| -------------- | --------------------------------------------- |
| `--batch-size` | Process N test cases at a time (default: 500) |
| `--reset`      | Delete all INFERRED links before re-running   |

**Example:**

```bash
npm run etl:infer:jira
npm run etl:infer:jira -- --reset   # full re-inference
```

---

### `etl:infer:jira-testrail`

Infers `jira_testrail_link` rows by bridging through data already in the database. No API calls required — runs purely against Postgres.

**Two strategies:**

| Strategy              | Method                                                                                                      | Provenance | Confidence |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | ---------- | ---------- |
| A — Automation bridge | Normalizes `testrail_case.title` ↔ `test_case.title`, then follows `jira_automation_link` to get issue keys | INFERRED   | HIGH       |
| B — Title similarity  | Jaccard token-overlap between `testrail_case.title` and `jira_issue.summary`. Suppresses ambiguous matches. | INFERRED   | MED        |

Strategy A runs first. Strategy B only runs on cases that have no link after A.
Both strategies skip cases that already have EXPLICIT links (written by `sync-testrail` from the TestRail `refs` field).

**Key flags:**

| Flag               | Description                                                                      |
| ------------------ | -------------------------------------------------------------------------------- |
| `--strategy`       | `a`, `b`, or `both` (default: `both`)                                            |
| `--min-similarity` | Minimum Jaccard score for strategy B (default: `0.45`)                           |
| `--ambiguity-gap`  | Suppress strategy B match if top-2 scores are within this gap (default: `0.15`)  |
| `--jira-projects`  | Comma-separated Jira project keys to restrict Jira side of matching (e.g. `QAA`) |

**Examples:**

```bash
npm run etl:infer:jira-testrail -- --dry-run --explain
npm run etl:infer:jira-testrail -- --strategy a
npm run etl:infer:jira-testrail -- --strategy b --min-similarity 0.5 --jira-projects QAA
npm run etl:infer:jira-testrail
```

---

### `etl:snapshot:coverage`

Reads the current KPI values from `v_executed_coverage_summary` and inserts one row into `coverage_snapshot`. Run this on a schedule to build a coverage trend time-series.

**Key flags:**

| Flag      | Description                                |
| --------- | ------------------------------------------ |
| `--force` | Insert even if a snapshot exists for today |

**Example:**

```bash
npm run etl:snapshot:coverage
```

---

### `analyze:flakes`

Analyzes `TestExecution` history over a rolling window and writes `FlakeDecision` rows. A test is a flake candidate when it alternates pass/fail within the same window.

**Key flags:**

| Flag            | Description                                                   |
| --------------- | ------------------------------------------------------------- |
| `--window-days` | Rolling window size in days (default: 14)                     |
| `--min-runs`    | Minimum executions required for analysis (default: 5)         |
| `--min-score`   | Minimum flake score threshold (default: 0.1)                  |
| `--resolve`     | Mark resolved any FlakeDecision whose test is no longer flaky |

**Example:**

```bash
npm run analyze:flakes -- --window-days 30 --resolve
```

---

## Artifact storage

See [`docs/artifact-storage.md`](docs/artifact-storage.md) for the full reference including GCS key layout, local dev setup, production GCP configuration, and the migration script.

### Quick summary

Every ingest run uploads artifacts to GCS before writing their URIs to Postgres:

| What                          | Where stored                                         | DB field                                     |
| ----------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| Raw JUnit XML source          | `gs://bucket/builds/{id}/source/junit-xml/`          | `RawArtifact.storageUri`                     |
| Raw Playwright JSON source    | `gs://bucket/builds/{id}/source/playwright-json/`    | `RawArtifact.storageUri`                     |
| Screenshots / videos / traces | `gs://bucket/builds/{id}/attachments/{executionId}/` | `TestExecution.artifactLinks` (JSON)         |
| Per-attempt stdout / stderr   | `gs://bucket/builds/{id}/attachments/{executionId}/` | `BuildLog.storageUri` + `TestAttempt.logUri` |

**Local dev:** all calls hit `fake-gcs-server` at `http://localhost:4443` — same SDK, different endpoint.

**Production:** remove `GCS_EMULATOR_HOST` from the environment. The SDK uses Application Default Credentials / Workload Identity automatically.

---

## SQL views reference

Applied via `npm run db:views`. All views are defined in `scripts/sql/coverage-views.sql`.

### Coverage

| View                                             | Description                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `v_req_universe`                                 | Full universe of Jira requirements eligible for coverage tracking             |
| `v_coverage_matrix`                              | Per-issue coverage status (linked, auto-executed, manual-executed, uncovered) |
| `v_coverage_summary`                             | Single-row KPI summary (total, linked, covered, uncovered counts)             |
| `v_executed_coverage_summary`                    | KPI summary including 30-day execution recency                                |
| `v_coverage_by_project`                          | Coverage percentages grouped by Jira project key                              |
| `v_coverage_by_epic`                             | Coverage percentages grouped by parent epic                                   |
| `v_coverage_by_priority`                         | Coverage percentages grouped by Jira priority                                 |
| `v_auto_executed_30d` / `v_auto_executed_7d`     | Issues with automated test runs in the last 30 / 7 days                       |
| `v_manual_executed_30d` / `v_manual_executed_7d` | Issues with manual test runs in the last 30 / 7 days                          |
| `v_executed_coverage_matrix`                     | Extended coverage matrix with execution recency flags                         |

### Link Governance

| View                          | Description                                      |
| ----------------------------- | ------------------------------------------------ |
| `v_best_auto_link`            | Highest-confidence automated link per Jira issue |
| `v_best_manual_link`          | Highest-confidence manual link per Jira issue    |
| `v_orphan_tests`              | Tests with no Jira link and ≥1 recent execution  |
| `v_orphan_summary`            | Aggregate orphan counts and orphan rate %        |
| `v_unreviewed_links`          | INFERRED links not yet marked `reviewed=true`    |
| `v_link_confidence_breakdown` | Link count by type × confidence level            |

### Execution Health

| View                 | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| `v_suite_health`     | Per-suite pass rate, average duration, and last-run timestamp |
| `v_flake_candidates` | Tests flagged as flaky, with flake rate and severity          |

---

## Metabase dashboards

Run `npm run mb:setup` to bootstrap three dashboards (idempotent — safe to re-run; use `--reset` to wipe and recreate).

```bash
npm run mb:setup               # create if absent
npm run mb:setup -- --reset    # delete and recreate
npm run mb:setup -- --dry-run  # preview without writing
```

| Dashboard                 | Audience     | Key cards                                                                                                                        |
| ------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **Coverage Overview**     | Stakeholders | Auto-tested %, Manual-tested %, Fully Uncovered count, Coverage Trend line, Coverage by Project/Priority, Uncovered Issues table |
| **Suite Health & Flakes** | Engineering  | Avg Pass Rate, High-Severity Flakes count, Suite Health table, Flake Candidates table                                            |
| **Link Governance**       | QA Analysts  | Orphan Rate %, Needs Review count, Link Confidence breakdown, Unreviewed Links queue, Orphan Tests table                         |

**Metabase credentials** (configured in `.env`):

```
METABASE_URL=http://localhost:3000
METABASE_ADMIN_EMAIL=admin@test-intel.local
METABASE_ADMIN_PASSWORD=TestIntel1!
```

---

## Jenkins pipeline (Playwright)

**File lives in a separate repo:** `evite-playwright/scripts/playwright_pipeline.groovy`
(i.e. `/Users/joe.peters/Development/evite-playwright/scripts/playwright_pipeline.groovy`)

Declarative pipeline for running Playwright tests with native sharding and automatic result ingestion into this database.

**Stage flow:**

1. **Notify Started** — Slack notification
2. **Install Dependencies** — `npm install` + Playwright browsers
3. **Run Playwright Shards** — N parallel shards, each writing `pw-results/shard-N-of-TOTAL.json`
4. **Ingest Results** — runs `etl:ingest:playwright` per shard with full CI metadata

**Parameters:** `project` (acceptance/integration/pro/tsunami/mobile), `shards` (default: 4), `workers` (default: 4), `branch`, `environment`, `base_url`, `ingest` (bool).

**Required Jenkins setup:**

| What                                    | Where                                                         |
| --------------------------------------- | ------------------------------------------------------------- |
| `TEST_INTEL_DATABASE_URL`               | Jenkins → Credentials (Secret text)                           |
| `GCS_BUCKET`                            | Jenkins → Global env vars (e.g. `evite-test-intel-artifacts`) |
| `GCS_PROJECT`                           | Jenkins → Global env vars (e.g. `evite-production`)           |
| `SLACK_VERSION_AUTOMATION_WORKFLOW_URL` | Jenkins → Credentials (already used by Selenium pipeline)     |
| `RESULTS_REPO_URL`                      | Manage Jenkins → System → Global env vars                     |

`GCS_EMULATOR_HOST` must **not** be set in Jenkins. When absent, the GCS SDK uses the GCP service account attached to the Jenkins agent (Workload Identity or a JSON key credential). See [`docs/artifact-storage.md`](docs/artifact-storage.md) for full production GCP setup.

---

## Environment variables

All vars live in `.env`. Sensitive credentials are commented out by default.

```bash
# ── Database (required) ───────────────────────────────────────────────────────
DATABASE_URL="postgresql://test_intel:test_intel@localhost:5432/test_intel?schema=public"

# ── Google Cloud Storage (required for all ingest scripts) ───────────────────
GCS_BUCKET="test-intel-artifacts"          # bucket name
GCS_PROJECT="test-intel-local"             # GCP project ID (any string works for dev)
GCS_EMULATOR_HOST="localhost:4443"         # local dev only — remove in production
                                           # when absent: SDK uses ADC / Workload Identity

# ── Jira sync (optional — only needed for etl:sync:jira) ─────────────────────
JIRA_BASE_URL="https://yourorg.atlassian.net"
JIRA_EMAIL="service-account@yourorg.com"
JIRA_API_TOKEN="your-atlassian-api-token"
JIRA_PROJECTS="QAA,PROJ"                  # default project list

# ── TestRail sync (optional — only needed for etl:sync:testrail) ─────────────
TESTRAIL_BASE_URL="https://yourorg.testrail.io"
TESTRAIL_EMAIL="service-account@yourorg.com"
TESTRAIL_API_TOKEN="your-testrail-api-key"
TESTRAIL_PROJECT_IDS="1,2"                # default project IDs (plural — for sync)
TESTRAIL_PROJECT_ID=1                     # single project ID (for etl:push:testrail)

# ── Metabase (only needed for mb:setup) ──────────────────────────────────────
METABASE_URL="http://localhost:3000"
METABASE_ADMIN_EMAIL="admin@test-intel.local"
METABASE_ADMIN_PASSWORD="TestIntel1!"
METABASE_SITE_NAME="Test Intelligence"
```

`GCS_BUCKET` and `GCS_PROJECT` are **required** by all ingest scripts — they will fail fast at startup if either is missing. `GCS_EMULATOR_HOST` is optional and only meaningful in local development.
