---
name: etl-run
description: Run a Trapeze ETL script interactively, surfacing dry-run/explain/limit options and summarizing output
---

Help the user run a Trapeze ETL script from `package.json`.

## Available Scripts

### Ingest

| Script                  | Purpose                                  |
| ----------------------- | ---------------------------------------- |
| `etl:ingest:junit`      | Parse JUnit XML files → Postgres         |
| `etl:ingest:playwright` | Parse Playwright JSON results → Postgres |
| `etl:ingest:from-gcs`   | Drain GCS drop zone → Postgres           |

### Sync & Infer

| Script                    | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `etl:sync:jira`           | Upsert Jira Cloud issues                           |
| `etl:sync:testrail`       | Upsert TestRail cases + results                    |
| `etl:infer:jira`          | Text-match test titles → jira_automation_link rows |
| `etl:infer:testrail`      | Title-match → automation_testrail_link rows        |
| `etl:infer:jira-testrail` | Infer jira_testrail_link via bridge + similarity   |

### Analytics

| Script                    | Purpose                                        |
| ------------------------- | ---------------------------------------------- |
| `etl:seed:coverage-epics` | Create 14 feature-area Jira epics (idempotent) |
| `etl:snapshot:coverage`   | Write one coverage_snapshot row (daily KPI)    |
| `analyze:flakes`          | Detect & classify test flakes                  |

## Steps

1. Ask which script to run (or infer from context if obvious).
2. Ask about flags — only for scripts that support them:
   - `--dry-run` — show what would change, no DB writes
   - `--explain` — verbose logging (useful for debugging)
   - `--limit N` — cap rows processed (useful for first runs)
3. Confirm and run: `npm run <script> -- [flags]`
4. Summarize output: rows inserted/updated/skipped, errors, warnings.
5. If the run produced errors, suggest next steps (recheck `.env`, verify DB is up with `npm run db:up`, etc.).

## Notes

- Always ensure the DB is running (`npm run db:up`) before ingestion scripts
- `etl:ingest:from-gcs` requires `GCS_BUCKET` and `GCS_PROJECT` in `.env`
- Sync scripts require `JIRA_*` or `TESTRAIL_*` env vars
