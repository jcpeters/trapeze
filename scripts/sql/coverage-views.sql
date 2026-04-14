-- =============================================================================
-- coverage-views.sql
--
-- Test coverage and quality metric views for the test-intel Postgres database.
--
-- Apply  :  npm run db:views
-- Safe   :  CREATE OR REPLACE — idempotent, re-run at any time
-- Order  :  views are declared in strict dependency order; do not reorder
--
-- QUOTING REFERENCE
--   Prisma default (no @map)  →  PascalCase table, camelCase column
--     "Build"               "startedAt", "jobName", "buildNumber", …
--     "TestCase"            "identityKey", "suiteName", "filePath", …
--     "TestCaseResult"      "testCaseId", "buildId", "durationMs", …
--   Prisma @map             →  snake_case table, snake_case column (no quotes needed)
--     jira_issue            issue_key, issue_type, project_key, parent_key, …
--     testrail_case         tr_case_id, section_path, …
--     jira_automation_link  issue_key, test_case_id, confidence, provenance, …
--     jira_testrail_link    issue_key, tr_case_id, confidence, provenance, …
-- =============================================================================


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  LAYER 0 — Foundation                                                     ║
-- ║  Raw building blocks.  All other views depend on these.                   ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ---------------------------------------------------------------------------
-- v_req_universe
-- The canonical denominator for all coverage percentages.
-- Excludes Epics (they aggregate stories), Sub-tasks (implementation details),
-- and Cancelled issues.  Adjust issue_type / status filters for your workflow.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_req_universe AS
SELECT
    ji.issue_key,
    ji.issue_type,
    ji.summary,
    ji.status,
    ji.parent_key   AS epic_key,
    ji.project_key,
    ji.priority,
    ji.labels,
    ji.created_at,
    ji.updated_at,
    ji.resolved_at
FROM jira_issue ji
WHERE ji.issue_type IN ('Story', 'Bug', 'Task')
  AND COALESCE(ji.status, '') <> 'Cancelled';

-- ---------------------------------------------------------------------------
-- v_best_auto_link
-- Deduplicates jira_automation_link: when the same (issue_key, test_case_id)
-- pair exists at multiple confidence / provenance levels (e.g. an INFERRED
-- link later confirmed by an EXPLICIT tag), keep only the best row so that
-- coverage counts are not inflated.
--
-- Rank:  confidence  HIGH(1) > MED(2) > LOW(3)
--        provenance  EXPLICIT(1) > MANUAL(2) > INFERRED(3)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_best_auto_link AS
SELECT DISTINCT ON (issue_key, test_case_id)
    issue_key,
    test_case_id,
    provenance,
    confidence,
    evidence,
    source,
    created_at
FROM jira_automation_link
ORDER BY
    issue_key,
    test_case_id,
    CASE confidence
        WHEN 'HIGH' THEN 1
        WHEN 'MED'  THEN 2
        WHEN 'LOW'  THEN 3
    END,
    CASE provenance
        WHEN 'EXPLICIT'  THEN 1
        WHEN 'MANUAL'    THEN 2
        WHEN 'INFERRED'  THEN 3
    END;

-- ---------------------------------------------------------------------------
-- v_best_manual_link
-- Same deduplication for jira_testrail_link.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_best_manual_link AS
SELECT DISTINCT ON (issue_key, tr_case_id)
    issue_key,
    tr_case_id,
    provenance,
    confidence,
    evidence,
    source,
    created_at
FROM jira_testrail_link
ORDER BY
    issue_key,
    tr_case_id,
    CASE confidence
        WHEN 'HIGH' THEN 1
        WHEN 'MED'  THEN 2
        WHEN 'LOW'  THEN 3
    END,
    CASE provenance
        WHEN 'EXPLICIT'  THEN 1
        WHEN 'MANUAL'    THEN 2
        WHEN 'INFERRED'  THEN 3
    END;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  LAYER 1 — Per-issue coverage matrix                                      ║
-- ║  Primary view for Metabase dashboards.  One row per in-scope Jira issue.  ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ---------------------------------------------------------------------------
-- v_coverage_matrix
--
-- For each requirement, computes:
--   auto_link_count           — total linked automated test cases
--   reliable_auto_link_count  — HIGH/MED confidence only (excludes LOW/INFERRED)
--   manual_link_count         — total linked TestRail cases
--   reliable_manual_link_count
--   has_* boolean flags for quick filtering in dashboards
--
-- The LEFT JOIN + COUNT(DISTINCT) pattern handles many-to-many safely:
-- if an issue has 3 auto and 2 manual links the cross product is 6 rows,
-- but DISTINCT collapses them back to the correct counts.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_coverage_matrix AS
SELECT
    r.issue_key,
    r.issue_type,
    r.summary,
    r.status,
    r.epic_key,
    r.project_key,
    r.priority,

    -- ── Automation ──────────────────────────────────────────────────────────
    COUNT(DISTINCT a.test_case_id)
        AS auto_link_count,
    COUNT(DISTINCT a.test_case_id) FILTER (WHERE a.confidence IN ('HIGH', 'MED'))
        AS reliable_auto_link_count,
    (COUNT(DISTINCT a.test_case_id) > 0)::BOOLEAN
        AS has_auto_coverage,
    (COUNT(DISTINCT a.test_case_id) FILTER (WHERE a.confidence IN ('HIGH', 'MED')) > 0)::BOOLEAN
        AS has_reliable_auto_coverage,

    -- ── Manual ──────────────────────────────────────────────────────────────
    COUNT(DISTINCT m.tr_case_id)
        AS manual_link_count,
    COUNT(DISTINCT m.tr_case_id) FILTER (WHERE m.confidence IN ('HIGH', 'MED'))
        AS reliable_manual_link_count,
    (COUNT(DISTINCT m.tr_case_id) > 0)::BOOLEAN
        AS has_manual_coverage,
    (COUNT(DISTINCT m.tr_case_id) FILTER (WHERE m.confidence IN ('HIGH', 'MED')) > 0)::BOOLEAN
        AS has_reliable_manual_coverage,

    -- ── Combined ────────────────────────────────────────────────────────────
    (COUNT(DISTINCT a.test_case_id) > 0 OR COUNT(DISTINCT m.tr_case_id) > 0)::BOOLEAN
        AS has_any_coverage,
    (   COUNT(DISTINCT a.test_case_id) FILTER (WHERE a.confidence IN ('HIGH', 'MED')) > 0
     OR COUNT(DISTINCT m.tr_case_id)   FILTER (WHERE m.confidence IN ('HIGH', 'MED')) > 0
    )::BOOLEAN
        AS has_reliable_coverage,
    (COUNT(DISTINCT a.test_case_id) > 0 AND COUNT(DISTINCT m.tr_case_id) > 0)::BOOLEAN
        AS has_dual_coverage

FROM v_req_universe r
LEFT JOIN v_best_auto_link   a ON a.issue_key = r.issue_key
LEFT JOIN v_best_manual_link m ON m.issue_key = r.issue_key
GROUP BY
    r.issue_key, r.issue_type, r.summary, r.status,
    r.epic_key,  r.project_key, r.priority;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  LAYER 2 — Aggregate coverage reports                                     ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ---------------------------------------------------------------------------
-- v_coverage_summary
-- Single-row snapshot of top-level coverage metrics.
-- "reliable" figures exclude LOW-confidence-only links.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_coverage_summary AS
SELECT
    COUNT(*)                                                            AS total_issues,

    -- Automation
    COUNT(*) FILTER (WHERE has_auto_coverage)                          AS auto_covered,
    COUNT(*) FILTER (WHERE has_reliable_auto_coverage)                 AS auto_covered_reliable,
    ROUND(100.0 * COUNT(*) FILTER (WHERE has_auto_coverage)
                / NULLIF(COUNT(*), 0), 1)                              AS auto_pct,
    ROUND(100.0 * COUNT(*) FILTER (WHERE has_reliable_auto_coverage)
                / NULLIF(COUNT(*), 0), 1)                              AS auto_reliable_pct,

    -- Manual
    COUNT(*) FILTER (WHERE has_manual_coverage)                        AS manual_covered,
    COUNT(*) FILTER (WHERE has_reliable_manual_coverage)               AS manual_covered_reliable,
    ROUND(100.0 * COUNT(*) FILTER (WHERE has_manual_coverage)
                / NULLIF(COUNT(*), 0), 1)                              AS manual_pct,
    ROUND(100.0 * COUNT(*) FILTER (WHERE has_reliable_manual_coverage)
                / NULLIF(COUNT(*), 0), 1)                              AS manual_reliable_pct,

    -- Combined
    COUNT(*) FILTER (WHERE has_any_coverage)                           AS combined_covered,
    COUNT(*) FILTER (WHERE has_reliable_coverage)                      AS combined_covered_reliable,
    ROUND(100.0 * COUNT(*) FILTER (WHERE has_any_coverage)
                / NULLIF(COUNT(*), 0), 1)                              AS combined_pct,
    ROUND(100.0 * COUNT(*) FILTER (WHERE has_reliable_coverage)
                / NULLIF(COUNT(*), 0), 1)                              AS combined_reliable_pct,

    -- Dual (both automation AND manual)
    COUNT(*) FILTER (WHERE has_dual_coverage)                          AS dual_covered,
    ROUND(100.0 * COUNT(*) FILTER (WHERE has_dual_coverage)
                / NULLIF(COUNT(*), 0), 1)                              AS dual_pct,

    -- Gap
    COUNT(*) FILTER (WHERE NOT has_any_coverage)                       AS uncovered,
    ROUND(100.0 * COUNT(*) FILTER (WHERE NOT has_any_coverage)
                / NULLIF(COUNT(*), 0), 1)                              AS uncovered_pct,

    NOW()::DATE                                                        AS as_of_date

FROM v_coverage_matrix;

-- ---------------------------------------------------------------------------
-- v_coverage_by_project  — bar chart: worst-covered projects first
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_coverage_by_project AS
SELECT
    COALESCE(project_key, '(unknown)')                                 AS project_key,
    COUNT(*)                                                           AS total_issues,
    COUNT(*) FILTER (WHERE has_reliable_auto_coverage)                 AS auto_covered,
    COUNT(*) FILTER (WHERE has_reliable_manual_coverage)               AS manual_covered,
    COUNT(*) FILTER (WHERE has_reliable_coverage)                      AS combined_covered,
    COUNT(*) FILTER (WHERE NOT has_any_coverage)                       AS uncovered,
    ROUND(100.0 * COUNT(*) FILTER (WHERE has_reliable_auto_coverage)
                / NULLIF(COUNT(*), 0), 1)                              AS auto_pct,
    ROUND(100.0 * COUNT(*) FILTER (WHERE has_reliable_manual_coverage)
                / NULLIF(COUNT(*), 0), 1)                              AS manual_pct,
    ROUND(100.0 * COUNT(*) FILTER (WHERE has_reliable_coverage)
                / NULLIF(COUNT(*), 0), 1)                              AS combined_pct
FROM v_coverage_matrix
GROUP BY project_key
ORDER BY combined_pct ASC NULLS LAST;

-- ---------------------------------------------------------------------------
-- v_coverage_by_epic  — breakdown by parent epic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_coverage_by_epic AS
SELECT
    COALESCE(cm.epic_key, '(no epic)')                                 AS epic_key,
    ji_epic.summary                                                    AS epic_summary,
    COUNT(*)                                                           AS story_count,
    COUNT(*) FILTER (WHERE cm.has_reliable_auto_coverage)              AS auto_covered,
    COUNT(*) FILTER (WHERE cm.has_reliable_manual_coverage)            AS manual_covered,
    COUNT(*) FILTER (WHERE cm.has_reliable_coverage)                   AS combined_covered,
    COUNT(*) FILTER (WHERE NOT cm.has_any_coverage)                    AS uncovered,
    ROUND(100.0 * COUNT(*) FILTER (WHERE cm.has_reliable_auto_coverage)
                / NULLIF(COUNT(*), 0), 1)                              AS auto_pct,
    ROUND(100.0 * COUNT(*) FILTER (WHERE cm.has_reliable_coverage)
                / NULLIF(COUNT(*), 0), 1)                              AS combined_pct
FROM v_coverage_matrix cm
LEFT JOIN jira_issue ji_epic ON ji_epic.issue_key = cm.epic_key
GROUP BY cm.epic_key, ji_epic.summary
ORDER BY combined_pct ASC NULLS LAST;

-- ---------------------------------------------------------------------------
-- v_coverage_by_priority  — breakdown by Jira priority
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_coverage_by_priority AS
SELECT
    COALESCE(priority, '(unset)')                                      AS priority,
    COUNT(*)                                                           AS total_issues,
    COUNT(*) FILTER (WHERE has_reliable_auto_coverage)                 AS auto_covered,
    COUNT(*) FILTER (WHERE has_reliable_manual_coverage)               AS manual_covered,
    COUNT(*) FILTER (WHERE has_reliable_coverage)                      AS combined_covered,
    COUNT(*) FILTER (WHERE NOT has_any_coverage)                       AS uncovered,
    ROUND(100.0 * COUNT(*) FILTER (WHERE has_reliable_coverage)
                / NULLIF(COUNT(*), 0), 1)                              AS combined_pct
FROM v_coverage_matrix
GROUP BY priority
ORDER BY
    CASE COALESCE(priority, '(unset)')
        WHEN 'Highest'  THEN 1
        WHEN 'High'     THEN 2
        WHEN 'Medium'   THEN 3
        WHEN 'Low'      THEN 4
        WHEN 'Lowest'   THEN 5
        ELSE 6
    END;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  LAYER 3 — Execution coverage (rolling windows)                           ║
-- ║  Distinguishes "linked" (design-time) from "executed" (run-time).         ║
-- ║  "Executed coverage" is the defensible metric to report to stakeholders.  ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ---------------------------------------------------------------------------
-- v_auto_executed_30d / v_auto_executed_7d
-- Per-issue: how many linked automated tests actually ran in the window.
-- Only HIGH/MED confidence links are counted — LOW links excluded to avoid
-- inflating executed-coverage numbers with unreviewed inferred links.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_auto_executed_30d AS
-- Covers both ingestion layers:
--   JUnit-era:      TestCase → TestCaseResult → Build.startedAt
--   Playwright-era: TestCase → TestExecution  → CiRun.createdAt
-- Window filter is in the JOIN condition so LEFT JOIN semantics work correctly
-- (a test case with runs outside the window still appears but is not counted).
SELECT
    a.issue_key,
    COUNT(DISTINCT a.test_case_id)                                        AS linked_test_count,
    COUNT(DISTINCT a.test_case_id)
        FILTER (WHERE
            (tcr.status IN ('PASSED', 'FAILED', 'ERROR') AND b."startedAt" IS NOT NULL)
            OR (te.status IN ('PASSED', 'FAILED', 'FLAKY', 'ERROR')      AND cr."createdAt" IS NOT NULL)
        )                                                                 AS executed_test_count,
    GREATEST(MAX(b."startedAt"), MAX(cr."createdAt"))                     AS last_run_at,
    BOOL_OR(
        (tcr.status = 'PASSED'  AND b."startedAt"  IS NOT NULL) OR
        (te.status  IN ('PASSED', 'FLAKY') AND cr."createdAt" IS NOT NULL)
    )                                                                     AS any_passed,
    BOOL_OR(
        (tcr.status = 'FAILED'  AND b."startedAt"  IS NOT NULL) OR
        (te.status  = 'FAILED'  AND cr."createdAt" IS NOT NULL)
    )                                                                     AS any_failed
FROM v_best_auto_link a
JOIN "TestCase"       tc  ON tc.id = a.test_case_id
-- JUnit-era path: window filter in JOIN so out-of-window builds yield NULL (not excluded)
LEFT JOIN "TestCaseResult" tcr ON tcr."testCaseId" = tc.id
LEFT JOIN "Build"          b   ON b.id = tcr."buildId"
                               AND b."startedAt" >= NOW() - INTERVAL '30 days'
-- Playwright-era path
LEFT JOIN "TestExecution"  te  ON te."testCaseId" = tc.id
LEFT JOIN "CiRun"          cr  ON cr.id = te."runId"
                               AND cr."createdAt" >= NOW() - INTERVAL '30 days'
WHERE a.confidence IN ('HIGH', 'MED')
  AND (b."startedAt" IS NOT NULL OR cr."createdAt" IS NOT NULL)
GROUP BY a.issue_key;

CREATE OR REPLACE VIEW v_auto_executed_7d AS
-- Mirrors v_auto_executed_30d with a 7-day window.
SELECT
    a.issue_key,
    COUNT(DISTINCT a.test_case_id)                                        AS linked_test_count,
    COUNT(DISTINCT a.test_case_id)
        FILTER (WHERE
            (tcr.status IN ('PASSED', 'FAILED', 'ERROR') AND b."startedAt" IS NOT NULL)
            OR (te.status IN ('PASSED', 'FAILED', 'FLAKY', 'ERROR')      AND cr."createdAt" IS NOT NULL)
        )                                                                 AS executed_test_count,
    GREATEST(MAX(b."startedAt"), MAX(cr."createdAt"))                     AS last_run_at,
    BOOL_OR(
        (tcr.status = 'PASSED'  AND b."startedAt"  IS NOT NULL) OR
        (te.status  IN ('PASSED', 'FLAKY') AND cr."createdAt" IS NOT NULL)
    )                                                                     AS any_passed,
    BOOL_OR(
        (tcr.status = 'FAILED'  AND b."startedAt"  IS NOT NULL) OR
        (te.status  = 'FAILED'  AND cr."createdAt" IS NOT NULL)
    )                                                                     AS any_failed
FROM v_best_auto_link a
JOIN "TestCase"       tc  ON tc.id = a.test_case_id
-- JUnit-era path
LEFT JOIN "TestCaseResult" tcr ON tcr."testCaseId" = tc.id
LEFT JOIN "Build"          b   ON b.id = tcr."buildId"
                               AND b."startedAt" >= NOW() - INTERVAL '7 days'
-- Playwright-era path
LEFT JOIN "TestExecution"  te  ON te."testCaseId" = tc.id
LEFT JOIN "CiRun"          cr  ON cr.id = te."runId"
                               AND cr."createdAt" >= NOW() - INTERVAL '7 days'
WHERE a.confidence IN ('HIGH', 'MED')
  AND (b."startedAt" IS NOT NULL OR cr."createdAt" IS NOT NULL)
GROUP BY a.issue_key;

-- ---------------------------------------------------------------------------
-- v_manual_executed_30d / v_manual_executed_7d
-- Per-issue: how many linked TestRail cases actually ran in the window.
-- Mirrors the structure of the auto views above.
--
-- TestRail status_id:  1=Passed  2=Blocked  3=Untested  4=Retest  5=Failed
-- "Executed" = NOT blocked(2) and NOT untested(3) — covers custom statuses too.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_manual_executed_30d AS
SELECT
    m.issue_key,
    COUNT(DISTINCT m.tr_case_id)                                       AS linked_test_count,
    COUNT(DISTINCT m.tr_case_id)
        FILTER (WHERE r.status_id NOT IN (2, 3))                       AS executed_test_count,
    MAX(r.tested_at)                                                   AS last_run_at,
    BOOL_OR(r.status_id = 1)                                           AS any_passed,
    BOOL_OR(r.status_id = 5)                                           AS any_failed
FROM v_best_manual_link m
JOIN testrail_result r ON r.tr_case_id = m.tr_case_id
WHERE m.confidence IN ('HIGH', 'MED')
  AND r.tested_at >= NOW() - INTERVAL '30 days'
GROUP BY m.issue_key;

CREATE OR REPLACE VIEW v_manual_executed_7d AS
SELECT
    m.issue_key,
    COUNT(DISTINCT m.tr_case_id)                                       AS linked_test_count,
    COUNT(DISTINCT m.tr_case_id)
        FILTER (WHERE r.status_id NOT IN (2, 3))                       AS executed_test_count,
    MAX(r.tested_at)                                                   AS last_run_at,
    BOOL_OR(r.status_id = 1)                                           AS any_passed,
    BOOL_OR(r.status_id = 5)                                           AS any_failed
FROM v_best_manual_link m
JOIN testrail_result r ON r.tr_case_id = m.tr_case_id
WHERE m.confidence IN ('HIGH', 'MED')
  AND r.tested_at >= NOW() - INTERVAL '7 days'
GROUP BY m.issue_key;

-- ---------------------------------------------------------------------------
-- v_executed_coverage_matrix
-- Extends v_coverage_matrix with auto and manual execution window flags.
-- "auto_executed_30d = true"   means ≥ 1 linked automated test ran in 30 days.
-- "manual_executed_30d = true" means ≥ 1 linked TestRail case ran in 30 days.
-- "linked_but_not_run_30d"     catches tests that are linked but stale.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_executed_coverage_matrix AS
SELECT
    cm.*,

    -- 30-day auto execution
    (COALESCE(e30.executed_test_count, 0) > 0)::BOOLEAN                AS auto_executed_30d,
    COALESCE(e30.executed_test_count, 0)                               AS auto_executed_test_count_30d,
    e30.last_run_at                                                    AS auto_last_run_at_30d,
    COALESCE(e30.any_passed, FALSE)                                    AS auto_any_passed_30d,
    COALESCE(e30.any_failed, FALSE)                                    AS auto_any_failed_30d,

    -- 7-day auto execution
    (COALESCE(e7.executed_test_count, 0) > 0)::BOOLEAN                 AS auto_executed_7d,
    COALESCE(e7.executed_test_count, 0)                                AS auto_executed_test_count_7d,

    -- Linked but stale: has reliable auto link, but nothing ran in 30 days
    (cm.has_reliable_auto_coverage
        AND COALESCE(e30.executed_test_count, 0) = 0)::BOOLEAN         AS linked_but_not_run_30d,

    -- 30-day manual execution
    (COALESCE(m30.executed_test_count, 0) > 0)::BOOLEAN                AS manual_executed_30d,
    COALESCE(m30.executed_test_count, 0)                               AS manual_executed_test_count_30d,
    m30.last_run_at                                                    AS manual_last_run_at_30d,
    COALESCE(m30.any_passed, FALSE)                                    AS manual_any_passed_30d,
    COALESCE(m30.any_failed, FALSE)                                    AS manual_any_failed_30d,

    -- 7-day manual execution
    (COALESCE(m7.executed_test_count, 0) > 0)::BOOLEAN                 AS manual_executed_7d,
    COALESCE(m7.executed_test_count, 0)                                AS manual_executed_test_count_7d

FROM v_coverage_matrix cm
LEFT JOIN v_auto_executed_30d    e30 ON e30.issue_key = cm.issue_key
LEFT JOIN v_auto_executed_7d     e7  ON e7.issue_key  = cm.issue_key
LEFT JOIN v_manual_executed_30d  m30 ON m30.issue_key = cm.issue_key
LEFT JOIN v_manual_executed_7d   m7  ON m7.issue_key  = cm.issue_key;

-- ---------------------------------------------------------------------------
-- v_executed_coverage_summary
-- Top-level executed coverage numbers — the most defensible metric to present.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_executed_coverage_summary AS
SELECT
    COUNT(*)                                                           AS total_issues,

    -- Auto execution
    COUNT(*) FILTER (WHERE auto_executed_30d)                          AS auto_executed_30d,
    ROUND(100.0 * COUNT(*) FILTER (WHERE auto_executed_30d)
                / NULLIF(COUNT(*), 0), 1)                              AS auto_executed_30d_pct,

    COUNT(*) FILTER (WHERE auto_executed_7d)                           AS auto_executed_7d,
    ROUND(100.0 * COUNT(*) FILTER (WHERE auto_executed_7d)
                / NULLIF(COUNT(*), 0), 1)                              AS auto_executed_7d_pct,

    -- Stale and uncovered
    COUNT(*) FILTER (WHERE linked_but_not_run_30d)                     AS linked_but_stale_30d,
    COUNT(*) FILTER (WHERE NOT has_any_coverage)                       AS fully_uncovered,

    -- Manual execution
    COUNT(*) FILTER (WHERE manual_executed_30d)                        AS manual_executed_30d,
    ROUND(100.0 * COUNT(*) FILTER (WHERE manual_executed_30d)
                / NULLIF(COUNT(*), 0), 1)                              AS manual_executed_30d_pct,

    COUNT(*) FILTER (WHERE manual_executed_7d)                         AS manual_executed_7d,
    ROUND(100.0 * COUNT(*) FILTER (WHERE manual_executed_7d)
                / NULLIF(COUNT(*), 0), 1)                              AS manual_executed_7d_pct,

    NOW()::DATE                                                        AS as_of_date

FROM v_executed_coverage_matrix;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  LAYER 4 — Orphan tests and link quality                                  ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ---------------------------------------------------------------------------
-- v_orphan_tests
-- Automated test cases with no Jira link of any confidence.
-- High orphan count = automation exists but can't be attributed to requirements.
-- Sort order: most recently run first (so active-but-unlinked tests appear top).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_orphan_tests AS
SELECT
    tc.id                                                              AS test_case_id,
    tc."identityKey",
    tc.title,
    tc."suiteName",
    tc."filePath",
    tc.tags,
    tc."createdAt"                                                     AS first_seen_at,
    MAX(b."startedAt")                                                 AS last_run_at,
    COUNT(tcr.id)                                                      AS total_runs,
    COUNT(tcr.id) FILTER (WHERE tcr.status = 'PASSED')                 AS pass_count,
    COUNT(tcr.id) FILTER (WHERE tcr.status = 'FAILED')                 AS fail_count,
    COUNT(tcr.id) FILTER (WHERE tcr.status = 'SKIPPED')                AS skip_count
FROM "TestCase" tc
LEFT JOIN "TestCaseResult" tcr ON tcr."testCaseId" = tc.id
LEFT JOIN "Build"          b   ON b.id             = tcr."buildId"
WHERE NOT EXISTS (
    SELECT 1
    FROM jira_automation_link al
    WHERE al.test_case_id = tc.id
)
GROUP BY
    tc.id, tc."identityKey", tc.title, tc."suiteName",
    tc."filePath", tc.tags, tc."createdAt"
ORDER BY last_run_at DESC NULLS LAST;

-- ---------------------------------------------------------------------------
-- v_orphan_summary
-- Aggregate orphan metrics — use in Metabase as summary cards.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_orphan_summary AS
WITH classified AS (
    SELECT
        tc.id,
        -- Has any link (including LOW confidence)
        EXISTS (
            SELECT 1 FROM jira_automation_link al
            WHERE al.test_case_id = tc.id
        ) AS has_any_link,
        -- Has at least one reliable link (HIGH or MED)
        EXISTS (
            SELECT 1 FROM jira_automation_link al
            WHERE al.test_case_id = tc.id
              AND al.confidence IN ('HIGH', 'MED')
        ) AS has_reliable_link,
        -- Only LOW-confidence links exist — needs analyst review
        EXISTS (
            SELECT 1 FROM jira_automation_link al
            WHERE al.test_case_id = tc.id
              AND al.confidence = 'LOW'
        ) AND NOT EXISTS (
            SELECT 1 FROM jira_automation_link al
            WHERE al.test_case_id = tc.id
              AND al.confidence IN ('HIGH', 'MED')
        ) AS low_confidence_only
    FROM "TestCase" tc
)
SELECT
    COUNT(*)                                                           AS total_test_cases,
    COUNT(*) FILTER (WHERE NOT has_any_link)                           AS orphan_count,
    ROUND(100.0 * COUNT(*) FILTER (WHERE NOT has_any_link)
                / NULLIF(COUNT(*), 0), 1)                              AS orphan_rate_pct,
    COUNT(*) FILTER (WHERE has_reliable_link)                          AS reliably_linked_count,
    COUNT(*) FILTER (WHERE low_confidence_only)                        AS low_confidence_only_count,
    COUNT(*) FILTER (WHERE has_any_link AND NOT has_reliable_link)     AS needs_review_count
FROM classified;

-- ---------------------------------------------------------------------------
-- v_unreviewed_links
-- LOW-confidence automation links that have no higher-confidence counterpart.
-- This is the analyst review queue: confirm, promote, or discard each row.
-- Order: oldest first so the backlog is worked in FIFO order.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_unreviewed_links AS
SELECT
    al.id                                                              AS link_id,
    al.issue_key,
    ji.summary                                                         AS jira_summary,
    ji.issue_type,
    al.test_case_id,
    tc.title                                                           AS test_title,
    tc."suiteName"                                                     AS suite_name,
    tc."identityKey"                                                   AS identity_key,
    al.confidence,
    al.provenance,
    al.evidence,
    al.source,
    al.created_at                                                      AS link_created_at
FROM jira_automation_link al
JOIN "TestCase" tc  ON tc.id             = al.test_case_id
JOIN jira_issue ji  ON ji.issue_key      = al.issue_key
WHERE al.confidence = 'LOW'
  AND NOT EXISTS (
      -- A higher-confidence link already covers this (issue, test) pair
      SELECT 1
      FROM jira_automation_link al2
      WHERE al2.issue_key    = al.issue_key
        AND al2.test_case_id = al.test_case_id
        AND al2.confidence IN ('HIGH', 'MED')
  )
ORDER BY al.created_at ASC;

-- ---------------------------------------------------------------------------
-- v_link_confidence_breakdown
-- Distribution of confidence levels across both link tables.
-- Shows the ratio of solid vs inferred coverage — key governance metric.
-- ---------------------------------------------------------------------------
-- PostgreSQL requires UNION ORDER BY expressions to be wrapped in a subquery.
CREATE OR REPLACE VIEW v_link_confidence_breakdown AS
SELECT *
FROM (
    SELECT
        'automation'                       AS link_type,
        confidence::TEXT,
        provenance::TEXT,
        COUNT(*)                           AS link_count,
        COUNT(DISTINCT issue_key)          AS distinct_issues,
        COUNT(DISTINCT test_case_id)       AS distinct_tests
    FROM jira_automation_link
    GROUP BY confidence, provenance

    UNION ALL

    SELECT
        'manual'                           AS link_type,
        confidence::TEXT,
        provenance::TEXT,
        COUNT(*)                           AS link_count,
        COUNT(DISTINCT issue_key)          AS distinct_issues,
        COUNT(DISTINCT tr_case_id::TEXT)   AS distinct_tests
    FROM jira_testrail_link
    GROUP BY confidence, provenance
) combined
ORDER BY
    link_type,
    CASE confidence
        WHEN 'HIGH' THEN 1
        WHEN 'MED'  THEN 2
        WHEN 'LOW'  THEN 3
    END,
    CASE provenance
        WHEN 'EXPLICIT'  THEN 1
        WHEN 'MANUAL'    THEN 2
        WHEN 'INFERRED'  THEN 3
    END;


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║  LAYER 5 — Flake rate and suite health                                    ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝

-- ---------------------------------------------------------------------------
-- v_flake_candidates
-- Tests whose status alternates (PASSED ↔ FAILED) within a rolling 14-day
-- window.  A "flip" is a status change between consecutive builds for the
-- same test case.  Requires ≥ 5 runs to produce a meaningful signal.
--
-- flake_rate_pct = flips / (total_runs - 1) × 100
--   0%   = never changes (stable pass or stable fail)
--   100% = alternates on every single run
--
-- Severity bands:  HIGH ≥ 50%   MED ≥ 20%   LOW < 20%
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_flake_candidates AS
WITH recent_runs AS (
    SELECT
        tcr."testCaseId"                                               AS test_case_id,
        b."startedAt"                                                  AS run_at,
        tcr.status,
        LAG(tcr.status) OVER (
            PARTITION BY tcr."testCaseId"
            ORDER BY b."startedAt"
        )                                                              AS prev_status
    FROM "TestCaseResult" tcr
    JOIN "Build" b ON b.id = tcr."buildId"
    WHERE b."startedAt" >= NOW() - INTERVAL '14 days'
      AND tcr.status IN ('PASSED', 'FAILED')   -- exclude SKIPPED / ERROR from flip calc
),
flip_stats AS (
    SELECT
        test_case_id,
        COUNT(*)                                                       AS total_runs,
        COUNT(*) FILTER (
            WHERE status <> prev_status
              AND prev_status IS NOT NULL
        )                                                              AS flip_count
    FROM recent_runs
    GROUP BY test_case_id
    HAVING COUNT(*) >= 5
)
SELECT
    f.test_case_id,
    tc."identityKey",
    tc.title,
    tc."suiteName",
    f.total_runs,
    f.flip_count,
    ROUND(100.0 * f.flip_count / NULLIF(f.total_runs - 1, 0), 1)      AS flake_rate_pct,
    CASE
        WHEN ROUND(100.0 * f.flip_count / NULLIF(f.total_runs - 1, 0), 1) >= 50 THEN 'HIGH'
        WHEN ROUND(100.0 * f.flip_count / NULLIF(f.total_runs - 1, 0), 1) >= 20 THEN 'MED'
        ELSE                                                                         'LOW'
    END                                                                AS flake_severity,
    -- Surface the Jira issues these flaky tests are attributed to
    STRING_AGG(DISTINCT al.issue_key, ', ' ORDER BY al.issue_key)     AS linked_jira_keys
FROM flip_stats f
JOIN "TestCase"            tc  ON tc.id             = f.test_case_id
LEFT JOIN jira_automation_link al ON al.test_case_id = f.test_case_id
GROUP BY
    f.test_case_id, tc."identityKey", tc.title, tc."suiteName",
    f.total_runs, f.flip_count
ORDER BY flake_rate_pct DESC NULLS LAST;

-- ---------------------------------------------------------------------------
-- v_suite_health
-- Per-suite pass rate, error rate, and average duration over the last 14 days.
-- NULL pass_rate_pct means the suite ran but all results were SKIPPED.
-- ---------------------------------------------------------------------------
-- Each metric is computed in its own CTE to avoid cross-join inflation from
-- multiple one-to-many joins on the same base table.
CREATE OR REPLACE VIEW v_suite_health AS
WITH suite_cases AS (
    -- Total distinct test cases per suite (all time)
    SELECT "suiteName" AS suite_name, COUNT(DISTINCT id) AS test_case_count
    FROM "TestCase"
    WHERE "suiteName" IS NOT NULL
    GROUP BY "suiteName"
),
recent_stats AS (
    -- Pass/fail/skip counts and duration within the rolling 14-day window
    SELECT
        tc."suiteName"                                                 AS suite_name,
        COUNT(tcr.id)                                                  AS total_runs_14d,
        COUNT(tcr.id) FILTER (WHERE tcr.status = 'PASSED')             AS pass_count,
        COUNT(tcr.id) FILTER (WHERE tcr.status = 'FAILED')             AS fail_count,
        COUNT(tcr.id) FILTER (WHERE tcr.status = 'SKIPPED')            AS skip_count,
        COUNT(tcr.id) FILTER (WHERE tcr.status = 'ERROR')              AS error_count,
        ROUND(
            100.0
            * COUNT(tcr.id) FILTER (WHERE tcr.status = 'PASSED')
            / NULLIF(
                COUNT(tcr.id) FILTER (WHERE tcr.status IN ('PASSED', 'FAILED', 'ERROR')),
                0
              ),
            1
        )                                                              AS pass_rate_pct,
        ROUND(
            AVG(tcr."durationMs") FILTER (WHERE tcr.status = 'PASSED') / 1000.0,
            2
        )                                                              AS avg_pass_duration_sec
    FROM "TestCase"       tc
    JOIN "TestCaseResult" tcr ON tcr."testCaseId" = tc.id
    JOIN "Build"          b   ON b.id             = tcr."buildId"
    WHERE tc."suiteName" IS NOT NULL
      AND b."startedAt" >= NOW() - INTERVAL '14 days'
    GROUP BY tc."suiteName"
),
last_run AS (
    -- Most recent execution across all time (not windowed) — useful for staleness
    SELECT tc."suiteName" AS suite_name, MAX(b."startedAt") AS last_run_at
    FROM "TestCase"       tc
    JOIN "TestCaseResult" tcr ON tcr."testCaseId" = tc.id
    JOIN "Build"          b   ON b.id             = tcr."buildId"
    WHERE tc."suiteName" IS NOT NULL
    GROUP BY tc."suiteName"
)
SELECT
    s.suite_name,
    s.test_case_count,
    COALESCE(r.total_runs_14d, 0)                                      AS total_runs_14d,
    COALESCE(r.pass_count, 0)                                          AS pass_count,
    COALESCE(r.fail_count, 0)                                          AS fail_count,
    COALESCE(r.skip_count, 0)                                          AS skip_count,
    COALESCE(r.error_count, 0)                                         AS error_count,
    r.pass_rate_pct,
    r.avg_pass_duration_sec,
    l.last_run_at
FROM suite_cases  s
LEFT JOIN recent_stats r ON r.suite_name = s.suite_name
LEFT JOIN last_run     l ON l.suite_name = s.suite_name
ORDER BY pass_rate_pct ASC NULLS LAST;


