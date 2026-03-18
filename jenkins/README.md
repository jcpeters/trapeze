# Trapeze Jenkins Pipelines

Scheduled pipeline definitions for the Trapeze Test Intelligence Platform.

## Jobs Overview

| Jenkinsfile | Jenkins Job Name | Schedule | Purpose |
|---|---|---|---|
| `Jenkinsfile.sync-jira` | `trapeze-sync-jira` | Nightly ~6 AM | Upsert Jira issues → `jira_issue` |
| `Jenkinsfile.sync-testrail` | `trapeze-sync-testrail` | Nightly ~6 AM | Upsert TestRail cases + results |
| `Jenkinsfile.snapshot-coverage` | `trapeze-snapshot-coverage` | Nightly ~7 AM | Write daily `coverage_snapshot` row |
| `Jenkinsfile.analyze-flakes` | `trapeze-analyze-flakes` | Weekly Mon ~8 AM | Write `FlakeDecision` rows |
| `Jenkinsfile.ingest-from-gcs` | `trapeze-ingest-from-gcs` | Every 15 min | Drain GCS drop zone → Postgres |

---

## One-Time Setup

### 1. Create Jenkins Credentials

In **Manage Jenkins → Credentials → System → Global credentials**, add:

| ID | Type | Value |
|---|---|---|
| `trapeze-db-url` | Secret text | Full `DATABASE_URL` (e.g. `postgresql://user:pass@host:5432/trapeze`) |
| `trapeze-jira-base-url` | Secret text | `https://yourorg.atlassian.net` |
| `trapeze-jira-email` | Secret text | Jira service account email |
| `trapeze-jira-api-token` | Secret text | Atlassian API token |
| `trapeze-testrail-base-url` | Secret text | `https://yourorg.testrail.io` |
| `trapeze-testrail-email` | Secret text | TestRail service account email |
| `trapeze-testrail-api-token` | Secret text | TestRail API key |
| `trapeze-gcs-bucket` | Secret text | GCS bucket name (no `gs://` prefix) |
| `trapeze-gcs-credentials` | Secret file | GCP service account JSON key |

### 2. Add a `trapeze` Agent Label

These pipelines use `agent { label 'trapeze' }`. Either:
- Add the label `trapeze` to an existing node in **Manage Jenkins → Nodes**, or
- Change the label to match your environment (e.g. `any` for testing).

The agent needs:
- Node.js 20+ on `PATH`
- `npm` available
- Network access to Postgres, Jira, TestRail, and GCS

### 3. Create Each Jenkins Pipeline Job

For each job:

1. **New Item** → name it (e.g. `trapeze-sync-jira`) → **Pipeline**
2. Under **Pipeline**:
   - Definition: `Pipeline script from SCM`
   - SCM: Git, repo URL, credentials
   - Branch: `main`
   - Script Path: `jenkins/Jenkinsfile.sync-jira` (adjust per job)
3. Check **"Do not allow concurrent builds"** for sync/snapshot jobs
4. Save — the cron trigger in the Jenkinsfile handles scheduling automatically

### 4. First Run

Run each job manually once to verify credentials and confirm it completes cleanly before relying on the scheduled trigger.

---

## Dependency Order

The nightly jobs should complete in this order:

```
~6 AM   sync-jira        (parallel)
~6 AM   sync-testrail    (parallel)
~7 AM   snapshot-coverage  (reads views built from ^ sync data)
Mon 8AM analyze-flakes   (reads TestExecution data from CI ingest)
*/15    ingest-from-gcs  (continuous — independent of above)
```

The `H` token in cron expressions spreads load across the hour. If you need strict ordering, replace the snapshot trigger with a downstream build trigger on both sync jobs completing.

---

## Notification Setup

Each Jenkinsfile has a commented-out `slackSend` block in the `post { failure }` section. Uncomment and configure with your Slack workspace credentials and channel name once the Jenkins Slack plugin is installed.
