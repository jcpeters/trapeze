# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the Trapeze Test Intelligence Platform.

## Authorship and Intent

**All decisions in this directory were made by Joe Peters**, who designed and built Trapeze as the sole architect and engineer. There was no design committee, no RFC process, and no team deliberation — every trade-off was evaluated and resolved by one person.

This is precisely why written rationale matters here. In a team setting, architectural decisions accumulate shared memory: the Slack thread where an alternative was ruled out, the whiteboard session where the data model took shape, the PR comment that explains a non-obvious constraint. None of that exists for Trapeze. The rationale that would normally be distributed across a team's collective memory lives in one person's head — and these ADRs are the mechanism for externalizing it.

**For future developers and AI assistants:** treat the Context and Mitigations sections of each ADR as the primary source of truth for _why_ the system is shaped the way it is. The code tells you _what_ was built; these records tell you _why_ the alternatives were rejected and what constraints the current design is optimizing for. When a decision looks surprising or over-engineered, the answer is almost always in the Context section.

---

## Format

ADRs were reverse-engineered from the codebase, documentation, and git history in March 2026.
Each record follows the standard format: **Context → Decision → Consequences (Positive / Negative / Mitigations)**.

To propose a new ADR, copy an existing file, increment the number, and open a PR for review.

---

## Index

| ADR                                                                 | Title                                                       | Domain               |
| ------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------- |
| [0001](./0001-dual-ingestion-layers.md)                             | Dual Ingestion Layers (JUnit Legacy + Playwright Modern)    | Data Model           |
| [0002](./0002-single-cloud-sql-instance-two-databases.md)           | Single Cloud SQL Instance, Two Databases                    | Infrastructure       |
| [0003](./0003-gcs-drop-zone-with-child-process-ingest.md)           | GCS Drop Zone with Child Process Ingest                     | Architecture         |
| [0004](./0004-single-cirun-per-build-not-per-shard.md)              | Single CiRun per Build, Not per Shard                       | Data Model           |
| [0005](./0005-test-identity-key-strategy.md)                        | Test Identity Key Strategy (Framework-Specific)             | Data Model           |
| [0006](./0006-link-provenance-and-confidence-hierarchy.md)          | Link Provenance and Confidence Hierarchy                    | Data Model           |
| [0007](./0007-regex-text-matching-for-inferred-links.md)            | Regex Text-Matching for Inferred Links (No LLM)             | ETL                  |
| [0008](./0008-watermark-tracking-for-sync-scripts.md)               | Watermark Tracking for Incremental Sync                     | ETL                  |
| [0009](./0009-gcs-for-binaries-postgres-for-metadata.md)            | GCS for Binary Artifacts; Postgres for Queryable Metadata   | Storage              |
| [0010](./0010-fake-gcs-emulator-for-local-development.md)           | Fake GCS Emulator for Local Development (No Mocks)          | Developer Experience |
| [0011](./0011-standalone-tsx-scripts-no-orchestration-framework.md) | Standalone `tsx` Scripts, No Orchestration Framework        | Architecture         |
| [0012](./0012-prisma-orm-with-sql-views-for-analytics.md)           | Prisma ORM for Writes; SQL Views for Analytics              | Data Access          |
| [0013](./0013-two-distinct-jenkins-agent-roles.md)                  | Two Distinct Jenkins Agent Roles                            | CI / Security        |
| [0014](./0014-playwright-blob-reporter-and-merge-reports.md)        | Playwright Blob Reporter + `merge-reports` for Sharded Runs | CI                   |
| [0015](./0015-metabase-over-custom-dashboard-ui.md)                 | Metabase for Stakeholder Dashboards (No Custom UI)          | Frontend             |
| [0016](./0016-testrail-push-direction.md)                           | TestRail Push Direction: DB → TestRail Write-Direction Sync | ETL                  |
