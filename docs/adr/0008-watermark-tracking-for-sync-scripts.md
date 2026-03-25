# ADR 0008: Watermark Tracking for Incremental Sync

- **Date:** 2026-03-24
- **Author:** Joe Peters
- **Status:** Accepted

## Context

Trapeze syncs two external systems on a nightly schedule:

- **Jira Cloud** — issue metadata (summary, status, priority, epic, labels) for all projects in `JIRA_PROJECTS`
- **TestRail** — test case definitions and run results

Both systems can have thousands of issues/cases. Fetching all records on every sync run wastes API quota, increases sync duration, and adds unnecessary load to the external APIs.

Three strategies were considered:

1. **Full backfill every run** — simple but O(N) API calls regardless of change volume; rate-limited on large instances
2. **Cursor-based pagination with stored cursor** — requires a `sync_state` table; cursor semantics vary per API
3. **Watermark (high-water mark) tracking** — store the highest `updatedAt` timestamp from the previous run; query only records updated since then

## Decision

Use **watermark tracking**:

- After each sync, compute `MAX(updatedAt)` (or `MAX(tested_at)` for TestRail results) from the locally stored records
- On the next run, pass `updatedSince=<watermark>` to the external API
- Ranges are **inclusive** (`>=` not `>`) to handle clock skew and ensure records updated exactly at the watermark boundary are not skipped
- All writes use **upsert** semantics so running twice with the same watermark is idempotent
- `--full-sync` flag available for backfill or disaster recovery

## Consequences

**Positive:**

- **Efficient:** on a typical night, only 20–200 Jira issues change; sync completes in seconds instead of minutes
- **API quota friendly:** nightly sync uses a small fraction of Jira's rate limit, leaving headroom for developer usage during the day
- **Observable:** sync logs show "fetched 47 issues updated since 2026-03-24T14:30:00Z" — easy to verify correctness
- **Idempotent:** upsert semantics make re-running safe; no duplicate records

**Negative:**

- **Deleted items are never removed** — if an issue is deleted in Jira, it remains in the local `jira_issue` table indefinitely
- **Clock skew risk** — if the external API's clock drifts significantly, records updated near the watermark boundary may be skipped in one run and caught in the next
- **Watermark loss** — if the local database is wiped, the watermark is lost and the next run fetches everything (equivalent to `--full-sync`)

**Mitigations:**

- Deleted items are acceptable: Jira issues are rarely hard-deleted (archived/closed instead); keeping stale records does not corrupt coverage metrics
- Inclusive watermark range (`>=`) absorbs minor clock skew; a one-minute overlap in fetched records is harmless due to upsert semantics
- `--full-sync` flag provides a manual recovery path after database wipes or watermark corruption
