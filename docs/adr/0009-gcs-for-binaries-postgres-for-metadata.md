# ADR 0009: GCS for Binary Artifacts; Postgres for Queryable Metadata

- **Date:** 2026-03-24
- **Author:** Joe Peters
- **Status:** Accepted

## Context

Test runs produce two categories of data:

1. **Queryable metadata** — test status (pass/fail/skip), duration, error message, stack trace, test name, suite name, environment label. Small per-test, high query frequency (Metabase dashboards, trend analysis).

2. **Binary artifacts** — raw JUnit XML files, Playwright JSON reports, screenshots (PNG), videos (WebM), execution traces (zip), stdout/stderr logs. Large per-run, accessed infrequently (debugging specific failures).

Storing binary artifacts in Postgres (as `BYTEA` columns) is technically possible but creates several problems: bloated table sizes, degraded index performance, expensive backup storage, no lifecycle management, and no CDN distribution for developer access.

## Decision

**Postgres stores:** test status, duration, error messages (up to ~5 KB), stack traces (up to ~20 KB), suite/test names, environment labels, and `gs://` URI pointers to binary artifacts.

**GCS stores:** raw XML/JSON source files, screenshots, videos, Playwright traces, and stdout/stderr log blobs.

All GCS access is mediated through `scripts/storage.ts`, which provides a single abstraction layer with six exports: `ensureBucket`, `uploadFile`, `uploadBuffer`, `signedUrl`, `buildKey`, `parseFileUri`. The only conditional in the codebase is `if (env.GCS_EMULATOR_HOST)` which routes to the local emulator in development and real GCS in production.

GCS key structure: `gs://bucket/builds/{buildId}/{artifactType}/{filename}`

## Consequences

**Positive:**

- **Query performance:** error messages and stack traces fit in `VARCHAR(5000)`; Metabase filters run in milliseconds against indexed Postgres columns
- **Storage cost:** GCS costs ~$0.02/GB/month; offloading binaries keeps Postgres size small and backups fast
- **Lifecycle management:** GCS lifecycle rules can expire videos after 30 days, screenshots after 90 days, while keeping XML/JSON indefinitely — without touching Postgres rows
- **Signed URLs:** GCS signed URLs let Metabase or a future UI serve screenshots directly without proxying through the application
- **Scalability:** binary storage scales independently of the database tier

**Negative:**

- **Extra API calls:** fetching an artifact requires a GCS API call in addition to the Postgres query
- **Orphaned artifacts:** if a `TestAttempt` row is deleted, its GCS artifacts become unreachable (no foreign key enforcement across systems)
- **Two failure modes:** a test result can have metadata in Postgres but a missing artifact in GCS (e.g., upload failed partway through)

**Mitigations:**

- Metabase dashboards query only Postgres columns; artifact URLs are surfaced as hyperlinks, not inline downloads — most users never trigger a GCS API call
- Soft-delete semantics (archived flag) rather than hard deletes prevent orphaned artifact URIs
- GCS lifecycle rules apply to entire key prefixes, not individual objects — no risk of deleting an artifact whose Postgres row still exists unless the retention window is shorter than the build's age
