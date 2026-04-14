# ADR 0016: TestRail Push Direction — DB → TestRail Write-Direction Sync

- **Date:** 2026-04-09
- **Author:** Joe Peters
- **Status:** Accepted

## Context

`etl:sync:testrail` (ADR-0008) pulls TestRail cases and run results into Postgres on a read-only basis. This gives Trapeze visibility into manual test execution but creates a one-way information flow: the test intelligence database knows about both automated and manual runs, but TestRail only knows about the manual ones.

The missing direction is writing **automated Playwright results back into TestRail** so that:

1. QA analysts can see automated pass/fail status alongside manual results in a single TestRail view
2. Automation coverage gaps are visible to people who live in TestRail, not just in Metabase
3. Teams using TestRail for release sign-off can include automated test results in the same workflow

Several design constraints shaped this feature:

- **Shard-aware CiRuns:** A sharded Playwright run produces multiple JSON files, but `ingest-playwright.ts` merges them into a single `CiRun` (ADR-0004). By the time the push script runs, shard results are already unified — reading from the DB is strictly better than re-parsing individual JSON files.
- **TestRail run immutability:** Closed TestRail runs cannot be updated. A simple upsert strategy would require tracking run state and reopening runs, which is fragile and error-prone.
- **Link table as bridge:** The `automation_testrail_link` table already maps `TestCase.id` → `tr_case_id` (populated by `etl:infer:testrail` and explicit `@C1234` annotations in Playwright). This is the correct join point — not raw file paths or test titles.
- **FLAKY is not the same as FAILED:** A test that passes on retry is a different signal than a hard failure. Mapping FLAKY → TestRail "Retest" (status 4) rather than "Failed" (status 5) preserves this distinction in TestRail reports.

## Decision

Implement `push-testrail-results.ts` as a standalone write-direction ETL script with the following design choices:

**1. DB is the source of truth, not JSON files.**
The script reads `CiRun → TestExecution → TestCase → automation_testrail_link` from Postgres. It does not re-parse JSON files. This ensures shard merging, deduplication, and status normalization (already done by ingest) are not repeated.

**2. Each invocation creates a new TestRail run.**
Rather than upsert into an existing run, each push creates a fresh `POST /add_run` + `POST /add_results_for_cases`. This avoids the complexity of tracking run identity and reopening closed runs. Idempotency is the caller's responsibility: re-running the same `--ci-run-id` produces a second TestRail run, which is safe and auditable.

**3. Status mapping: FLAKY → Retest (4), not Failed (5).**
FLAKY means the test passed on at least one retry within the same CiRun. Retest signals "needs attention but not a hard block", which is the correct interpretation for a reviewer deciding whether to sign off a release.

**4. Minimum confidence threshold: MED by default.**
Links with confidence HIGH or MED are included by default. LOW-confidence links (weak title overlap) are excluded unless the caller explicitly passes `--min-confidence LOW`. EXPLICIT links (from `@C1234` annotations) always take precedence over inferred ones.

**5. Annotation-based case IDs take precedence.**
Playwright tests using `test.info().annotations` with `type: 'TestRail'` and `description: 'C1234'` create EXPLICIT/HIGH links in `automation_testrail_link`. These are never overridden by inferred links.

**6. Jenkins pipeline (`Jenkinsfile.push-testrail`) runs on the `trapeze` agent.**
The push script requires `DATABASE_URL` and TestRail API credentials — it belongs to the ETL role, not the test execution role (ADR-0013). The pipeline supports three invocation modes: single CiRun, job+build, or batch-since-date.

**7. Slack failure notification via `trapezeSlackNotify`.**
The pipeline's `post { failure }` block calls the shared library step `trapezeSlackNotify(status: 'FAILURE')`. The credential is optional — if `trapeze-slack-webhook-url` is absent the step logs a warning and does not fail the build.

## Consequences

**Positive:**

- **Bidirectional TestRail integration:** Trapeze now reads from and writes to TestRail, making it a true bridge between automated CI data and manual QA workflows
- **Release sign-off support:** Teams can include automated Playwright results in TestRail-based release checklists without manual data entry
- **FLAKY visibility in TestRail:** Flaky tests appear as "Retest" rather than "Failed", giving reviewers accurate signal
- **Reuses existing link infrastructure:** No new join logic — `automation_testrail_link` (already maintained by ingest + inference) is the authoritative bridge

**Negative:**

- **Duplicate TestRail runs on re-invocation:** Each push creates a new run. Teams must be aware that re-running the same build produces a second TestRail run, not an update to the first.
- **Link coverage dependency:** Push results are only as good as the `automation_testrail_link` table. Tests without links are silently skipped. Gaps in inference or annotation coverage mean gaps in TestRail results.
- **Additional TestRail API credentials in Jenkins:** The `trapeze` agent now needs TestRail write credentials (`trapeze-testrail-api-token`, `trapeze-testrail-email`, `trapeze-testrail-base-url`), which were previously only needed by the sync script.

**Mitigations:**

- `--dry-run` mode shows exactly which cases would be included/excluded and why, making link coverage gaps visible before committing to a push
- The `Jenkinsfile.push-testrail` `DRY_RUN` parameter defaults to `false` but can be toggled without a code change for ad-hoc inspection
- The `--min-confidence` flag lets callers tighten or loosen the link quality threshold without changing code
