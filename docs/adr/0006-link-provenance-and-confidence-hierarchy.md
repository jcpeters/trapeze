# ADR 0006: Link Provenance and Confidence Hierarchy

- **Date:** 2026-03-24
- **Author:** Joe Peters
- **Status:** Accepted

## Context

Trapeze maintains a coverage graph connecting automated tests to Jira issues and TestRail cases via three link tables:

- `JiraAutomationLink` (Jira issue ↔ automated `TestCase`)
- `AutomationTestRailLink` (automated `TestCase` ↔ TestRail case)
- `JiraTestRailLink` (Jira issue ↔ TestRail case, inferred via bridge)

Links can come from multiple sources with varying degrees of trustworthiness:

- A developer writes `@QAA-123` in a test annotation (ground truth)
- A heuristic script finds keyword overlap between a test name and a Jira summary (probabilistic)
- An analyst manually asserts a link after investigation (verified but not from source code)

A boolean `isVerified` field cannot represent this nuance. Storing only the highest-confidence link loses the audit trail and prevents analysts from reviewing what was inferred.

## Decision

Every link table carries two classification fields:

**`provenance: enum(EXPLICIT, INFERRED, MANUAL)`** — ordered by source trustworthiness:

- `EXPLICIT`: sourced directly from test code (tag, annotation, XML `<property>`)
- `INFERRED`: produced by a heuristic/text-matching script
- `MANUAL`: asserted by an analyst via direct database write or future UI

**`confidence: enum(HIGH, MED, LOW)`** — fine-grained certainty within a provenance level:

- Typically `EXPLICIT → HIGH`, `INFERRED → LOW` or `MED`, `MANUAL → HIGH`

A **unique constraint on `(issueKey, testCaseId, provenance)`** allows the same pair to have both an `EXPLICIT HIGH` link (from code) and an `INFERRED LOW` link (from heuristics) simultaneously — they coexist without conflict.

Inference scripts always write `provenance=INFERRED` and **never delete or overwrite** `EXPLICIT` or `MANUAL` links.

SQL views (e.g., `v_jira_automation_best_link`) use `DISTINCT ON (issueKey, testCaseId) ORDER BY provenance DESC, confidence DESC` to surface the single most trustworthy link per pair for dashboard consumption.

## Consequences

**Positive:**

- Indestructible audit trail: re-running inference never loses ground-truth links from source code
- Dashboards can filter by confidence (exclude `LOW` inferred links for high-stakes coverage reports)
- Analysts can review inferred links and promote them to `MANUAL` after verification
- Provenance makes it clear why a link exists — essential for trust in coverage metrics

**Negative:**

- Queries must account for multiple rows per pair (mitigated by SQL views)
- Schema is more complex than a simple foreign key relationship
- Analysts need to understand the three-level hierarchy before writing coverage queries

**Mitigations:**

- SQL views provide the canonical "best link" view for all Metabase dashboards
- Inference scripts log their evidence (matched keyword, regex capture) in an `evidence` JSONB column for debugging
- Documentation in CLAUDE.md and schema comments explains the hierarchy
