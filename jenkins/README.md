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

---

## Integrating with CI Test Jobs

Trapeze captures results from two job types: **legacy freestyle jobs** (shell script) and **modern pipeline jobs** (Groovy DSL). Both use the same `trapeze-push.sh` script — the difference is only in how it is called.

There are **two distinct agent roles** in Trapeze. Make sure you are configuring the right one:

| Role | Which agents | Needs DB? | Needs Jira/TestRail? | Needs GCS? |
|------|-------------|-----------|----------------------|------------|
| **Test execution** | Your existing Selenium / Playwright nodes | ❌ No | ❌ No | ✅ Write only |
| **Trapeze ETL** | The `trapeze`-labelled node (see One-Time Setup above) | ✅ Yes | ✅ Yes | ✅ Read + Write |

The `TRAPEZE_HOME` setup below applies **only to your test execution agents** — the machines that already run your Selenium and Playwright jobs. The `trapeze`-labelled ETL agent is configured separately via Jenkins credentials (see One-Time Setup).

### Test Execution Agent Setup

Each Jenkins agent that runs Selenium or Playwright tests needs:

1. **Node.js 20+** on `PATH`
2. **Trapeze repo** cloned to a fixed location and dependencies installed:
   ```
   git clone git@github.com:jcpeters/trapeze.git /opt/trapeze
   cd /opt/trapeze && npm ci
   ```
3. **`TRAPEZE_HOME`** set as a global Jenkins environment variable (`Manage Jenkins → System → Global properties → Environment variables`):
   ```
   TRAPEZE_HOME = /opt/trapeze
   ```
4. **GCS write credentials** — the agent only needs permission to upload files to the drop zone bucket. Set `GCS_BUCKET` in `/opt/trapeze/.env` on each agent:
   ```
   GCS_BUCKET=your-trapeze-drop-zone-bucket
   GOOGLE_APPLICATION_CREDENTIALS=/path/to/gcs-uploader-service-account.json
   ```
   This service account only needs the `Storage Object Creator` role on the bucket — it does not need DB, Jira, or TestRail access.

---

### Legacy Freestyle Jobs (Shell Script)

Add **one line** to the end of your existing `Execute shell` build step, after the test runner writes its result file but before the exit-code check.

**Selenium / pytest example** — based on the existing acceptance test job:

```bash
#!/bin/bash
# ... existing pyenv / venv / pytest setup ...

PYTHONPATH="" pytest -rxs -v -s --junitxml="../../logs/$BUILD_NUMBER.xml" \
  -n$NUM_NODES --maxfail=$MAX_FAIL -r R -l --cache-clear \
  --hub=$HUB --env=$ENV --browser=CHROME "$TEST_NAME"

# ── Trapeze: upload results to drop zone (non-fatal) ──────────────────────────
bash $TRAPEZE_HOME/scripts/trapeze-push.sh --framework pytest --result-file $WORKSPACE/webdriver-framework/logs/$BUILD_NUMBER.xml --environment $ENV
# ─────────────────────────────────────────────────────────────────────────────

rm -rf ${VENV_ROOT}
EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 1 ]]; then
  exit 1
fi
```

**Playwright example:**

```bash
npx playwright test --reporter=json 2>&1 | tee $WORKSPACE/playwright-report/results.json

bash $TRAPEZE_HOME/scripts/trapeze-push.sh --framework playwright --result-file $WORKSPACE/playwright-report/results.json --artifacts-dir $WORKSPACE/test-results --environment acceptance
```

The script reads `$JOB_NAME`, `$BUILD_NUMBER`, `$BUILD_URL`, `$GIT_COMMIT`, and `$GIT_BRANCH` automatically from the Jenkins environment. It **always exits 0** — a Trapeze failure will never fail your CI build.

---

### Modern Pipeline Jobs (Groovy DSL)

Add a `post { always { ... } }` block to your `Jenkinsfile`:

```groovy
pipeline {
  agent { label 'selenium' }
  stages {
    stage('Test') {
      steps {
        sh """
          pytest --junitxml=${WORKSPACE}/test-results.xml ...
        """
      }
    }
  }
  post {
    always {
      // Publish to Jenkins
      junit 'test-results.xml'

      // Upload to Trapeze drop zone
      sh "bash $TRAPEZE_HOME/scripts/trapeze-push.sh --framework pytest --result-file ${WORKSPACE}/test-results.xml --environment ${params.ENV ?: 'acceptance'}"
    }
  }
}
```

For Playwright with artifacts:

```groovy
post {
  always {
    sh "bash $TRAPEZE_HOME/scripts/trapeze-push.sh --framework playwright --result-file ${WORKSPACE}/playwright-report/results.json --artifacts-dir ${WORKSPACE}/test-results --environment acceptance"
  }
}
```

---

### Verifying the Integration

After a build runs, drain the drop zone from any machine with database access:

```bash
npm run etl:ingest:from-gcs -- --explain
```

Results should appear in Metabase within 15 minutes once the `trapeze-ingest-from-gcs` pipeline job is configured and running on its schedule.
