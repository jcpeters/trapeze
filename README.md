# Test Intelligence Platform (Trapeze)

A self-contained data platform for tracking test results, coverage, flakes, and Jira linkage across Selenium and Playwright CI runs.

**Stack:** Postgres 16 (Docker) · Prisma · TypeScript scripts · Metabase dashboards

**Repo:** `git@github.com:jcpeters/trapeze.git` *(pending transfer to `evite` org — once an org admin creates `evite/trapeze`, update remote with `git remote set-url origin git@github.com:evite/trapeze.git && git push -u origin main`)*

**Local path:** `/Users/joe.peters/Development/results`

---

## Status & known gaps

| Area | Status |
|------|--------|
| Schema + migrations | ✅ Complete (6 migrations) |
| JUnit ingest (Selenium/pytest) | ✅ Complete |
| Playwright ingest (JSON reporter, sharding, @tag Jira links) | ✅ Complete |
| Jira sync | ✅ Complete |
| TestRail sync | ✅ Complete |
| Jira link inference (text-match) | ✅ Complete |
| Flake detection | ✅ Complete |
| Coverage snapshots | ✅ Complete |
| 20 SQL analytics views | ✅ Complete |
| Metabase dashboards (3 dashboards, 19 cards) | ✅ Complete |
| Playwright Jenkins pipeline | ✅ Complete (`evite-playwright/scripts/playwright_pipeline.groovy`) |
| **Scheduled / cron job wiring** | ❌ Not done — all ETL scripts exist but nothing runs them automatically |

**Next task for a new agent:** Wire up a scheduler so that `etl:sync:jira`, `etl:sync:testrail`, `etl:snapshot:coverage`, and `analyze:flakes` run on a recurring schedule (e.g. daily cron, Jenkins scheduled build, or a simple node-cron wrapper).

---

## Architecture

```
  Jira Cloud ──── sync-jira.ts ──────────────────────────┐
  TestRail ─────── sync-testrail.ts ─────────────────────┤
  JUnit XML ──── ingest-junit.ts ─────────────────────────┤
  Playwright JSON ─ ingest-playwright.ts ─────────────────┤──► Postgres ──► SQL views ──► Metabase
                                                           │
  infer-jira-links.ts ── (text-match links) ─────────────┤
  detect-flakes.ts ────── (rolling-window flake math) ────┤
  snapshot-coverage.ts ── (KPI time-series row) ──────────┘
```

---

## Prereqs

- Docker
- Node.js 18+

---

## Quick start

```bash
# 1. Fill in credentials — .env already exists with local defaults;
#    add your Jira/TestRail API tokens as needed
#    (do NOT commit .env — it is gitignored)
#    edit .env directly

# 2. Install dependencies
npm install

# 3. Start Postgres + Metabase
npm run db:up

# 4. Run migrations
npm run db:migrate

# 5. Apply SQL analytics views
npm run db:views

# 6. (Optional) seed sample data
npm run db:seed

# 7. (Optional) set up Metabase dashboards
npm run mb:setup
```

Postgres is available at `postgresql://test_intel:test_intel@localhost:5432/test_intel`.
Metabase UI is at http://localhost:3000 (credentials configured in `.env`).

---

## Reset the database

```bash
npm run db:down       # stop containers
npm run db:reset      # drop + recreate volume
npm run db:up
npm run db:migrate
npm run db:views
npm run db:seed
```

---

## NPM scripts reference

### Database

| Script | Description |
|--------|-------------|
| `db:up` | Start Postgres + Metabase via Docker Compose |
| `db:down` | Stop containers |
| `db:reset` | Drop and recreate the Postgres volume (destructive) |
| `db:migrate` | Run Prisma migrations |
| `db:generate` | Regenerate Prisma client after schema changes |
| `db:seed` | Insert sample Jira issues, test cases, and CI runs |
| `db:views` | Apply all SQL analytics views from `scripts/sql/coverage-views.sql` |

### ETL — Ingest

| Script | Description |
|--------|-------------|
| `etl:ingest:junit` | Ingest a JUnit XML file (Selenium / pytest runs) |
| `etl:ingest:playwright` | Ingest a Playwright JSON reporter output file |

### ETL — Sync

| Script | Description |
|--------|-------------|
| `etl:sync:jira` | Pull Jira issues into `jira_issue` table |
| `etl:sync:testrail` | Pull TestRail test cases and results |
| `etl:infer:jira` | Text-match test titles against Jira issues to create `jira_automation_link` rows |
| `etl:snapshot:coverage` | Write one `coverage_snapshot` row from current `v_executed_coverage_summary` values |

### Analysis

| Script | Description |
|--------|-------------|
| `analyze:flakes` | Run rolling-window flake detection; write `flake_decision` rows |

### Metabase

| Script | Description |
|--------|-------------|
| `mb:setup` | Create/update Metabase DB connection, questions, and dashboards via API |

### Code quality

| Script | Description |
|--------|-------------|
| `lint` | Run ESLint across all TypeScript scripts |
| `format` | Run Prettier (write mode) across all files |

---

## ETL scripts — detailed reference

All scripts accept `--dry-run` (validate without writing) and `--explain` (verbose output).

### `etl:ingest:junit`

Ingests a JUnit XML file produced by pytest or Selenium into `Build`, `CiRun`, `TestCase`, `TestExecution`, and `JiraAutomationLink`.

**Required args:**

| Flag | Description |
|------|-------------|
| `--job` | Jenkins job full name |
| `--build` | Build number |

**Optional args:**

| Flag | Description |
|------|-------------|
| `--ci` | CI provider (default: `jenkins`) |
| `--suite` | Suite name override |
| `--framework` | Framework label (`pytest`, `playwright`, etc.) |
| `--build-url` | Link back to the CI build |
| `--git-sha` | Git commit SHA |
| `--branch` | Branch name |
| `--environment` | Target environment |
| `--started-at` / `--finished-at` | ISO timestamps |
| `--jira-property-names` | Comma-separated `<property>` names to extract Jira keys from |
| `--skip-jira-links` | Skip writing `jira_automation_link` rows |

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

| Flag | Description |
|------|-------------|
| `--json-path` | Path to the Playwright JSON file |
| `--job` | CI job full name |
| `--build` | Build number |

**Optional args:**

| Flag | Description |
|------|-------------|
| `--ci` | CI provider (default: `jenkins`) |
| `--build-url` | Link back to the CI build |
| `--git-sha` | Git commit SHA |
| `--branch` | Branch name |
| `--environment` | Target environment |
| `--pr-number` | Pull request number |
| `--shard-index` | 1-based shard index (omit if not sharding) |
| `--shard-total` | Total number of shards |
| `--project` | Filter to a single Playwright project name |
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

| Flag | Description |
|------|-------------|
| `--projects` | Comma-separated project keys (e.g. `QAA,PROJ`). Falls back to `JIRA_PROJECTS` env var |
| `--issue-types` | Filter by issue type (default: `Story,Bug,Task`) |
| `--updated-after` | ISO date — only sync issues updated after this date |
| `--full-sync` | Ignore `updated-after`; fetch all issues |
| `--page-size` | API page size (default: 100) |

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

| Flag | Description |
|------|-------------|
| `--project-ids` | Comma-separated TestRail project IDs. Falls back to `TESTRAIL_PROJECT_IDS` env var |
| `--suite-ids` | Limit to specific suite IDs |
| `--skip-cases` | Skip test case sync |
| `--skip-results` | Skip test result sync |
| `--full-sync` | Ignore incremental cutoff |
| `--updated-after` | ISO date for incremental sync |
| `--batch-size` | API batch size (default: 250) |

**Example:**
```bash
npm run etl:sync:testrail -- --project-ids 1,2
```

---

### `etl:infer:jira`

Scans `TestCase.identityKey`, `title`, and `suiteName` for Jira key patterns and writes `jira_automation_link` rows with `confidence=MEDIUM, provenance=INFERRED`. Safe to re-run; skips rows that already exist.

**Key flags:**

| Flag | Description |
|------|-------------|
| `--batch-size` | Process N test cases at a time (default: 500) |
| `--reset` | Delete all INFERRED links before re-running |

**Example:**
```bash
npm run etl:infer:jira
npm run etl:infer:jira -- --reset   # full re-inference
```

---

### `etl:snapshot:coverage`

Reads the current KPI values from `v_executed_coverage_summary` and inserts one row into `coverage_snapshot`. Run this on a schedule to build a coverage trend time-series.

**Key flags:**

| Flag | Description |
|------|-------------|
| `--force` | Insert even if a snapshot exists for today |

**Example:**
```bash
npm run etl:snapshot:coverage
```

---

### `analyze:flakes`

Analyzes `TestExecution` history over a rolling window and writes `FlakeDecision` rows. A test is a flake candidate when it alternates pass/fail within the same window.

**Key flags:**

| Flag | Description |
|------|-------------|
| `--window-days` | Rolling window size in days (default: 14) |
| `--min-runs` | Minimum executions required for analysis (default: 5) |
| `--min-score` | Minimum flake score threshold (default: 0.1) |
| `--resolve` | Mark resolved any FlakeDecision whose test is no longer flaky |

**Example:**
```bash
npm run analyze:flakes -- --window-days 30 --resolve
```

---

## SQL views reference

Applied via `npm run db:views`. All views are defined in `scripts/sql/coverage-views.sql`.

### Coverage

| View | Description |
|------|-------------|
| `v_req_universe` | Full universe of Jira requirements eligible for coverage tracking |
| `v_coverage_matrix` | Per-issue coverage status (linked, auto-executed, manual-executed, uncovered) |
| `v_coverage_summary` | Single-row KPI summary (total, linked, covered, uncovered counts) |
| `v_executed_coverage_summary` | KPI summary including 30-day execution recency |
| `v_coverage_by_project` | Coverage percentages grouped by Jira project key |
| `v_coverage_by_epic` | Coverage percentages grouped by parent epic |
| `v_coverage_by_priority` | Coverage percentages grouped by Jira priority |
| `v_auto_executed_30d` / `v_auto_executed_7d` | Issues with automated test runs in the last 30 / 7 days |
| `v_manual_executed_30d` / `v_manual_executed_7d` | Issues with manual test runs in the last 30 / 7 days |
| `v_executed_coverage_matrix` | Extended coverage matrix with execution recency flags |

### Link Governance

| View | Description |
|------|-------------|
| `v_best_auto_link` | Highest-confidence automated link per Jira issue |
| `v_best_manual_link` | Highest-confidence manual link per Jira issue |
| `v_orphan_tests` | Tests with no Jira link and ≥1 recent execution |
| `v_orphan_summary` | Aggregate orphan counts and orphan rate % |
| `v_unreviewed_links` | INFERRED links not yet marked `reviewed=true` |
| `v_link_confidence_breakdown` | Link count by type × confidence level |

### Execution Health

| View | Description |
|------|-------------|
| `v_suite_health` | Per-suite pass rate, average duration, and last-run timestamp |
| `v_flake_candidates` | Tests flagged as flaky, with flake rate and severity |

---

## Metabase dashboards

Run `npm run mb:setup` to bootstrap three dashboards (idempotent — safe to re-run; use `--reset` to wipe and recreate).

```bash
npm run mb:setup               # create if absent
npm run mb:setup -- --reset    # delete and recreate
npm run mb:setup -- --dry-run  # preview without writing
```

| Dashboard | Audience | Key cards |
|-----------|----------|-----------|
| **Coverage Overview** | Stakeholders | Auto-tested %, Manual-tested %, Fully Uncovered count, Coverage Trend line, Coverage by Project/Priority, Uncovered Issues table |
| **Suite Health & Flakes** | Engineering | Avg Pass Rate, High-Severity Flakes count, Suite Health table, Flake Candidates table |
| **Link Governance** | QA Analysts | Orphan Rate %, Needs Review count, Link Confidence breakdown, Unreviewed Links queue, Orphan Tests table |

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

| What | Where |
|------|-------|
| `TEST_INTEL_DATABASE_URL` | Jenkins → Credentials (Secret text) |
| `SLACK_VERSION_AUTOMATION_WORKFLOW_URL` | Jenkins → Credentials (already used by Selenium pipeline) |
| `RESULTS_REPO_URL` | Manage Jenkins → System → Global env vars |

---

## Environment variables

All vars live in `.env`. Sensitive credentials are commented out by default.

```bash
# Database (required)
DATABASE_URL="postgresql://test_intel:test_intel@localhost:5432/test_intel?schema=public"

# Jira sync (optional — only needed for etl:sync:jira)
JIRA_BASE_URL="https://yourorg.atlassian.net"
JIRA_EMAIL="service-account@yourorg.com"
JIRA_API_TOKEN="your-atlassian-api-token"
JIRA_PROJECTS="QAA,PROJ"           # default project list

# TestRail sync (optional — only needed for etl:sync:testrail)
TESTRAIL_BASE_URL="https://yourorg.testrail.io"
TESTRAIL_EMAIL="service-account@yourorg.com"
TESTRAIL_API_TOKEN="your-testrail-api-key"
TESTRAIL_PROJECT_IDS="1,2"         # default project IDs

# Metabase (only needed for mb:setup)
METABASE_URL="http://localhost:3000"
METABASE_ADMIN_EMAIL="admin@test-intel.local"
METABASE_ADMIN_PASSWORD="TestIntel1!"
METABASE_SITE_NAME="Test Intelligence"
```
