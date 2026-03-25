# ADR 0002: Single Cloud SQL Instance, Two Databases

- **Date:** 2026-03-24
- **Author:** Joe Peters
- **Status:** Accepted

## Context

Trapeze requires two independent PostgreSQL databases in production:

1. **`trapeze`** — application data (test results, Jira/TestRail links, coverage snapshots)
2. **`metabase`** — Metabase's internal metadata (dashboards, questions, user accounts, audit logs)

Both databases need persistent storage, automated backups, and private network access from Cloud Run services.

## Decision

Host both databases on a **single Cloud SQL for PostgreSQL 16 instance** (`trapeze-prod`), using database-level role grants for isolation:

- `trapeze_app` service account: access to `trapeze` database only
- `metabase_app` service account: access to `metabase` database only
- Neither role can read or write the other's database

Local development mirrors this with a single `postgres:16` Docker container hosting both databases via Docker Compose.

## Consequences

**Positive:**

- Halves the base infrastructure cost — Cloud SQL charges ~$25/month per instance minimum; one instance vs. two saves ~$300/year
- Simplified networking: both Cloud Run services connect to the same private IP endpoint
- Single backup policy covers both application data and BI tool state simultaneously
- One set of maintenance windows, SSL certificates, and monitoring alerts

**Negative:**

- Single point of failure: instance failure affects both the ETL pipeline and Metabase dashboards simultaneously
- Scaling is coupled: if either workload outgrows the instance tier (1.7 GB RAM on `db-f1-micro`), both must scale together
- Schema namespace collision risk if both applications use table names like `users` or `migrations`

**Mitigations:**

- Automated daily backups with point-in-time recovery (Cloud SQL default)
- Role grants enforce strict namespace separation at the database level, not just schema level
- `metabase` schema uses Metabase's internal prefix conventions; `trapeze` schema uses explicit model names — no collision risk in practice
- If workloads diverge significantly in scale, splitting into two instances requires only a connection string change in each service's Secret Manager entry
