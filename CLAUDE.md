# Trapeze — Test Intelligence Platform

## Key Commands

```bash
# Database
npm run db:up              # Start Postgres + fake-gcs (Docker)
npm run db:down            # Stop containers
npm run db:migrate         # Apply pending Prisma migrations
npm run db:generate        # Regenerate Prisma client after schema change (always run after schema edit)
npm run db:seed            # Seed initial data
npm run db:views           # Apply SQL analytics views

# ETL — Ingest
npm run etl:ingest:junit            # Parse JUnit XML files into Postgres
npm run etl:ingest:playwright       # Parse Playwright JSON results into Postgres
npm run etl:ingest:from-gcs         # Drain GCS drop zone into Postgres
npm run etl:upload:drop-zone        # Upload result file to GCS drop zone (CI agent)

# ETL — Sync & Infer
npm run etl:sync:jira               # Sync Jira Cloud issues → jira_issue table
npm run etl:sync:testrail           # Sync TestRail cases + results → DB
npm run etl:infer:jira              # Text-match test titles → jira_automation_link rows
npm run etl:infer:testrail          # Title-match → automation_testrail_link rows
npm run etl:infer:jira-testrail     # Infer jira_testrail_link via bridge + similarity

# ETL — Analytics
npm run etl:seed:coverage-epics     # Create 14 feature-area Jira epics (idempotent)
npm run etl:snapshot:coverage       # Write one coverage_snapshot row (daily KPI)
npm run analyze:flakes              # Detect & classify flakes → flake_decision rows

# Code quality
npm run lint                        # ESLint check
npm run format                      # Prettier format

# Database — reset
npm run db:reset             # Wipe and recreate local database (destructive)

# Metabase
npm run mb:setup             # Configure Metabase instance via API

# Storage (GCS)
npm run storage:bucket       # Create GCS bucket
npm run storage:lifecycle    # Apply lifecycle rules to bucket
npm run storage:migrate:dry  # Dry-run artifact migration (no writes)
npm run storage:migrate      # Migrate artifacts between storage locations

# Demo & local testing
npm run demo:e2e                    # Run end-to-end demo (Selenium + Playwright builds)

# Jenkins (local)
docker compose --profile jenkins up -d   # Start Jenkins LTS at http://localhost:8080
```

## Environment

All scripts load env via `scripts/env.ts` (Zod-validated). Required vars in `.env`:

```dotenv
DATABASE_URL=        # Postgres connection string
GCS_BUCKET=          # GCS bucket name
GCS_PROJECT=         # GCP project ID (default: test-intel-local)
GCS_EMULATOR_HOST=   # e.g. localhost:4443 for local fake-gcs (omit in prod)
```

Copy `.env` from a teammate or Secret Manager. Never commit it.

## Architecture

**Scripts** (`scripts/`) are standalone `tsx` executables. Each accepts:

- `--dry-run` — show what would change, no writes
- `--explain` — verbose logging
- `--limit N` — cap rows processed

**Database:** Prisma schema at `prisma/schema.prisma` (38 models, 9+ migrations). Always run `db:generate` after any schema change.

**GCS drop zone:** CI agents (no DB access) upload result files via `trapeze-push.sh` → GCS. The `trapeze-ingest-from-gcs` Jenkins job drains them every 15 min.

**Two agent roles in Jenkins:**

| Role                         | Needs DB? | Needs GCS?   |
| ---------------------------- | --------- | ------------ |
| Test execution agents        | No        | Write only   |
| `trapeze`-labelled ETL agent | Yes       | Read + Write |

**Jenkins pipelines:** `jenkins/Jenkinsfile.*` — local dev via `docker compose --profile jenkins up`.

**Sample data:** `junit_xml/`, `junit_json/`, `sample/` hold fixture XML/JSON for local ingest testing. `incoming/` is a local drop zone for manual GCS drain testing.

**Schema has two parallel ingestion layers:**

- _JUnit-era (legacy):_ `Build → TestSuite → TestCase → TestCaseResult → RawArtifact`
- _Playwright-era (modern):_ `CiRun → TestExecution → TestAttempt → BuildLog` (per-attempt logs, shard-aware)

Both layers share `TestCase.identityKey` for cross-reference. JUnit identity key = `md5(className#methodName)`; Playwright = stable file-path-based `testId`.

**Three link tables form the coverage graph:** `JiraAutomationLink` (Jira ↔ automated test), `AutomationTestRailLink` (automated ↔ TestRail), `JiraTestRailLink` (Jira ↔ TestRail). Each has `LinkProvenance` (EXPLICIT > INFERRED > MANUAL) and `LinkConfidence` (HIGH > MED > LOW). EXPLICIT = tag/property in source; INFERRED = text/title match heuristic.

**`ingest-from-gcs` spawns ingest scripts as child processes** (not imports) for isolation — a crash in one batch doesn't abort the drain loop. Failed batches move to `failed/YYYY-MM-DD/`.

**Sync scripts use watermark tracking** — `MAX(updatedAt/tested_at)` from the previous run. Use `--full-sync` for backfill/recovery. Ranges are inclusive so re-running is safe (upserts).

## DO NOT

- Edit `.env` directly — real API tokens live there; rotate and use `.env.local` or Secret Manager
- Run `npm install` in CI — use `npm ci`
- Edit `package-lock.json` manually
- Run `db:migrate` without running `db:generate` afterward
