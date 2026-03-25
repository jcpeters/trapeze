# ADR 0015: Metabase for Stakeholder Dashboards (No Custom UI)

- **Date:** 2026-03-24
- **Author:** Joe Peters
- **Status:** Accepted

## Context

Trapeze needs a dashboard layer that allows engineering managers, QA leads, and product owners to view test coverage trends, flake scores, and Jira/TestRail link quality — without writing SQL or accessing the database directly.

Options considered:

1. **Custom React/Vue dashboard** — full control over UX; high engineering cost; ongoing frontend maintenance
2. **Grafana** — open-source; optimized for time-series metrics (CPU, latency); weak support for relational/tabular test data
3. **Tableau / Looker** — powerful BI; expensive per-user licensing (~$70–150/user/month)
4. **Google Sheets + BigQuery export** — zero infrastructure cost; manual refresh; poor UX for ad hoc exploration
5. **Metabase** — open-source BI tool; SQL-first; self-hosted; Google SSO; ~$0–50/month infrastructure cost

## Decision

Use **Metabase** (open-source edition) as the sole stakeholder-facing dashboard layer.

Metabase is deployed as a containerized service:

- **Local development:** `metabase/metabase:latest` Docker container in `docker-compose.yml` (port 3000)
- **Production:** Cloud Run service (always-on, min-instances=1); authenticated via Google SSO (`@evite.com`)

Metabase's internal metadata (dashboards, questions, user accounts, audit logs) is stored in the `metabase` database on the shared Cloud SQL instance (see ADR 0002).

Dashboard definitions are bootstrapped via the Metabase REST API (`scripts/setup-metabase.ts`) so the initial dashboard setup is reproducible and not dependent on manual UI clicks.

## Consequences

**Positive:**

- **Zero frontend code:** no React components, no CSS, no build pipeline for the dashboard layer
- **SQL-first power users:** engineering managers and QA leads who know SQL can write native queries directly in Metabase without needing a developer
- **Fast iteration:** a new dashboard question takes 5–15 minutes to build by dragging and dropping from SQL views
- **Google SSO:** integrates with existing `@evite.com` Google Workspace; no separate password management or user provisioning
- **Row-level permissions:** Metabase groups map to Jira project scopes — QA leads can see only their team's test data
- **Low cost:** ~$35–50/month for a warm Cloud Run instance; no per-user licensing in the OSS edition

**Negative:**

- **Customization ceiling:** novel visualizations (e.g., interactive dependency graphs, custom JS charts) are not possible in Metabase OSS
- **Vendor dependency:** exporting dashboards requires Metabase's proprietary backup format or re-creation from scratch
- **Upgrade cadence:** Metabase releases frequently; occasional breaking changes in the metadata DB schema require testing before upgrades
- **No programmatic embed:** embedding Metabase questions in other tools (e.g., Slack, Confluence) requires Metabase Pro ($500/month) or a manual screenshot workflow

**Mitigations:**

- `scripts/setup-metabase.ts` re-creates dashboards idempotently via REST API — a future migration or upgrade can re-bootstrap from scratch in minutes
- SQL views (see ADR 0012) abstract the underlying schema; if Metabase is ever replaced, the views remain the stable interface for any successor BI tool
- For the current use case (trend analysis, coverage KPIs, flake scores), Metabase's built-in chart types are sufficient; novel visualizations are not required
