# ADR 0013: Two Distinct Jenkins Agent Roles

- **Date:** 2026-03-24
- **Author:** Joe Peters
- **Status:** Accepted

## Context

Trapeze's Jenkins environment hosts two fundamentally different workloads on the same Jenkins controller:

1. **Test execution** — run Selenium/Playwright/pytest test suites against the application under test; upload result files to GCS
2. **ETL and analytics** — sync Jira/TestRail, ingest GCS results into Postgres, snapshot coverage KPIs, detect flaky tests

These workloads have different security requirements:

| Concern          | Test Execution           | ETL / Analytics                                     |
| ---------------- | ------------------------ | --------------------------------------------------- |
| DB credentials   | Never                    | Required                                            |
| Jira API token   | Never                    | Required                                            |
| TestRail API key | Never                    | Required                                            |
| GCS access       | Write-only (`incoming/`) | Read + Write (`incoming/`, `processed/`, `failed/`) |
| Runs user code   | Yes                      | No                                                  |

Giving test execution agents full ETL credentials would mean that any test suite — including third-party or developer-contributed tests — could access production database credentials.

## Decision

Two distinct Jenkins agent roles, enforced by label:

**Test execution agents** (label: any, or omitted):

- Credentials: GCS service account with `storage.objects.create` on `incoming/**` only
- No DB connection string, no Jira/TestRail tokens
- Jenkinsfiles use `agent { label 'automation' }` or `agent any`

**Trapeze ETL agents** (label: `trapeze`):

- Credentials: full `DATABASE_URL`, Jira API token, TestRail API key, GCS read/write
- Never run user-supplied test code
- Jenkinsfiles use `agent { label 'trapeze' }`

In local development (Docker), the built-in Jenkins node carries both `trapeze` and `automation` labels (set by `03-create-jobs.groovy`) so all jobs can run on the single-node setup. In production, these are separate physical or ephemeral agents with separate credential stores.

## Consequences

**Positive:**

- **Principle of least privilege:** test agents hold the minimum credentials needed; a compromised agent cannot read or modify Trapeze data
- **Blast radius reduction:** if a test suite has a supply-chain attack or malicious dependency, it cannot exfiltrate database content
- **Auditability:** DB queries from the ETL role are distinguishable from test agent activity in Postgres logs
- **Scalability:** test execution agents can scale to hundreds of ephemeral runners without changing the ETL credential model

**Negative:**

- **Jenkins admin overhead:** agents must be labelled correctly; a mis-labelled agent either blocks ETL jobs (job waits forever) or over-privileges a test agent
- **Two credential stores:** separate GCP service accounts, IAM bindings, and Jenkins credential entries for each role
- **Local dev complexity:** the single-node Docker setup must carry both labels (documented in `03-create-jobs.groovy`)

**Mitigations:**

- `agent { label 'trapeze' }` in ETL Jenkinsfiles causes the job to wait — not fail silently — if no correctly labelled agent is available, making mis-labelling visible immediately
- Production uses Terraform to provision agents with the correct labels and IAM bindings, eliminating manual configuration
- Local dev label assignment is automated via `03-create-jobs.groovy` (idempotent `setLabelString` call on startup)
