# ADR 0011: Standalone `tsx` Scripts, No Orchestration Framework

- **Date:** 2026-03-24
- **Author:** Joe Peters
- **Status:** Accepted

## Context

Trapeze's ETL operations consist of ~15 distinct jobs:

- **Ingest:** `ingest-junit.ts`, `ingest-playwright.ts`, `ingest-from-gcs.ts`
- **Sync:** `sync-jira.ts`, `sync-testrail.ts`
- **Infer:** `infer-jira-links.ts`, `infer-testrail-links.ts`, `infer-jira-testrail-links.ts`
- **Analytics:** `snapshot-coverage.ts`, `analyze-flakes.ts`
- **Storage:** `create-bucket.ts`, `apply-lifecycle.ts`, `migrate-artifacts.ts`

Architectural options for hosting these jobs:

1. **Monolithic server** — Express/Fastify app with `/api/ingest`, `/api/sync-jira` endpoints; scheduled by an internal cron
2. **Shared Job base class** — hierarchy of job classes with common logging, retry, and error handling
3. **Message queue workers** — Pub/Sub or SQS consumers subscribing to a job queue
4. **Standalone scripts** — individual `tsx` executables, each a self-contained entrypoint

## Decision

Each ETL operation is a **standalone `tsx` executable**. Scripts share only three modules:

- `scripts/db/prisma.ts` — singleton Prisma client
- `scripts/storage.ts` — GCS abstraction
- `scripts/env.ts` — Zod-validated environment config

Every script accepts a standard set of CLI flags (`--dry-run`, `--explain`, `--limit N`) handled individually via `yargs`. Each script calls `process.exit(0)` on success and `process.exit(1)` on failure, making it directly invocable by Jenkins, Cloud Run Jobs, and Cloud Scheduler.

## Consequences

**Positive:**

- **Independent scheduling:** each job has its own cron expression in Jenkins/Cloud Scheduler; changing one job's schedule does not require redeploying others
- **Transparent logging:** `stdout`/`stderr` go directly to the Jenkins console or Cloud Run Job logs without middleware
- **Trivial local testing:** `npm run etl:sync:jira -- --dry-run --explain` runs the full script against local Postgres with no server startup
- **Zero framework overhead:** no Express, no Bull, no BullMQ, no task runner — just Node + `dotenv` + `yargs`
- **Cheap Cloud Run Jobs:** each job is billed only for its execution time (seconds); no always-on server needed for scheduled ETL
- **Deployable independently:** adding a new ETL script does not require modifying any existing code

**Negative:**

- **No shared error handling middleware:** each script must implement its own `try/catch` and `process.exit(1)` call
- **CLI arg boilerplate:** `--dry-run`, `--explain`, `--limit` are re-declared in each script (partially mitigated by a shared `yargs` defaults module)
- **Database connection not pooled globally:** each script opens and closes its own Prisma client; not a bottleneck for the current workload but would need revisiting under high concurrency

**Mitigations:**

- A shared `scripts/cli.ts` module (or future addition) can provide common `yargs` setup and a shared `runScript(fn)` wrapper that handles `process.exit` and top-level error logging
- Prisma's connection pool is per-process; Cloud Run Jobs run one process per invocation, so there is no connection pool contention
- The pattern makes it easy to promote any script to a standalone Cloud Run Job without architectural changes
