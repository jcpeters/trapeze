# ADR 0001: Dual Ingestion Layers (JUnit Legacy + Playwright Modern)

- **Date:** 2026-03-24
- **Author:** Joe Peters
- **Status:** Accepted

## Context

Trapeze began as a JUnit/Selenium ingest platform. As the team adopted Playwright, the two frameworks diverged significantly in their data models:

- **JUnit/Selenium**: Hierarchical `TestSuite → TestCase → TestCaseResult`; no concept of retries per attempt, shard indices, or per-attempt artifacts
- **Playwright**: Test-centric with `TestExecution → TestAttempt`; native retry semantics, shard awareness, per-attempt screenshots/traces/videos, and a stable file-path-based `testId`

Forcing Playwright results into the JUnit schema would require lossy mapping (discarding retry metadata, shard info, and per-attempt artifacts). Rewriting the JUnit schema to accommodate Playwright would break all existing Selenium pipelines and Metabase dashboards.

## Decision

Maintain two parallel, independent ingest data models:

**JUnit-era (legacy):**

```
Build → TestSuite → TestCase → TestCaseResult → RawArtifact
```

**Playwright-era (modern):**

```
Build → CiRun → TestExecution → TestAttempt → BuildLog
```

Both layers share the `TestCase` table via a common `identityKey` for cross-framework deduplication. Coverage link tables (`JiraAutomationLink`, `AutomationTestRailLink`) reference `TestCase` so both layers contribute to the same coverage graph.

## Consequences

**Positive:**

- Existing Selenium/pytest pipelines continue writing to the JUnit layer with zero migration cost
- Playwright layer uses idiomatic data structures: per-attempt retries, shard indices, trace/screenshot/video URIs
- Teams can adopt Playwright incrementally without abandoning existing test infrastructure
- Coverage analysis works across both layers via the shared `TestCase` identity key

**Negative:**

- Schema complexity: 38 models instead of ~15
- Coverage reports must account for both layers (mitigated by SQL views that `UNION` across both)
- A test appearing in both layers requires deduplication logic in inference scripts
- New developers must learn both models before contributing to ingest code

**Mitigations:**

- `TestCase.identityKey` is the canonical cross-reference point; inference scripts detect and link intelligently
- SQL views (`v_test_execution_summary`, etc.) abstract the dual-layer complexity for Metabase consumers
- CLAUDE.md documents the two layers prominently to orient new contributors
