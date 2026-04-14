# Trapeze — Production Deployment Plan

Target cloud: **Google Cloud Platform (GCP)**
ETL orchestration: **Existing production Jenkins** (cron-scheduled pipelines)

---

## Architecture Overview

```
                        ┌──────────────────────────────────────────────────────┐
                        │                    GCP Project                        │
                        │                                                        │
  Evite employees ──────►  Cloud Run: Metabase  ◄──── @evite.com Google SSO    │
  (browser, any network)│       (always-on)                                     │
                        │           │                                            │
                        │           ▼                                            │
                        │     Cloud SQL (Postgres 16, private IP)               │
                        │           ▲                                            │
                        │           │ Cloud SQL Auth Proxy                       │
                        └───────────┼────────────────────────────────────────────┘
                                    │
  ┌─────────────────────────────────┼──────────────────────────────────────────┐
  │  Existing Production Jenkins    │                                           │
  │                                 │                                           │
  │  ┌──────────────────────────────┴──────┐   ┌────────────────────────────┐  │
  │  │  trapeze-labeled ETL agent           │   │  Test execution agents     │  │
  │  │  (DB access + GCS read/write)        │   │  (no DB, GCS write only)   │  │
  │  │                                      │   │                            │  │
  │  │  trapeze-sync-jira       (nightly)   │   │  playwright-acceptance     │  │
  │  │  trapeze-sync-testrail   (nightly)   │   │  selenium-acceptance       │  │
  │  │  trapeze-snapshot-coverage(nightly)  │   │  ...any other CI jobs      │  │
  │  │  trapeze-analyze-flakes  (weekly)    │   │       │                    │  │
  │  │  trapeze-ingest-from-gcs (*/15 min)  │   │       │ trapeze-push.sh    │  │
  │  └──────────────────────────────────────┘   └───────┼────────────────────┘  │
  └────────────────────────────────────────────────────┼────────────────────────┘
                                                        │
                        ┌───────────────────────────────▼────────────────────────┐
                        │                    GCP Project                          │
                        │                                                          │
                        │     Cloud Storage: evite-trapeze-drop-zone              │
                        │     Cloud Storage: evite-trapeze-artifacts              │
                        │                                                          │
                        └──────────────────────────────────────────────────────────┘
```

### Services

| Component                      | Where it runs                                               | Purpose                                                 |
| ------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------- |
| Postgres database              | Cloud SQL (Postgres 16)                                     | All metadata — builds, executions, links, coverage      |
| Metabase dashboards            | Cloud Run (always-on)                                       | Stakeholder-facing dashboard UI                         |
| ETL jobs                       | Jenkins `trapeze`-labeled agent                             | Sync, ingest, analysis — scheduled by Jenkins cron      |
| Artifact / result file storage | Cloud Storage                                               | JUnit XML, Playwright JSON, screenshots, videos, traces |
| Secret storage                 | Jenkins credentials store (ETL) + Secret Manager (Metabase) | API tokens, DATABASE_URL, GCS bucket                    |
| Networking                     | VPC + Private Service Connect + Cloud SQL Auth Proxy        | Cloud SQL on private IP; proxy on Jenkins ETL agent     |

---

## 1. Cloud SQL

### Instance config

One Cloud SQL instance hosts **two databases** — `trapeze` (app data) and `metabase` (Metabase internal config).

```
Database engine : PostgreSQL 16
Instance name   : trapeze-prod
Instance tier   : db-g1-small (1 vCPU, 1.7 GB RAM)
                  Upgrade to db-custom-2-7680 if query latency becomes noticeable
Region          : us-west1 (same region as Cloud Run to minimise latency)
Connectivity    : Private IP only (no public IP)
Storage         : 20 GB SSD, auto-growth enabled
Backups         : Automated daily, 7-day retention
```

### Databases and users

| Database   | User           | Used by                  | Connection                                         |
| ---------- | -------------- | ------------------------ | -------------------------------------------------- |
| `trapeze`  | `trapeze_app`  | Jenkins ETL jobs         | `DATABASE_URL` in Jenkins credentials store        |
| `metabase` | `metabase_app` | Metabase internal config | `MB_DB_*` env vars on Cloud Run via Secret Manager |

### Setup commands

```bash
# 1. Create Cloud SQL instance
gcloud sql instances create trapeze-prod \
  --database-version=POSTGRES_16 \
  --tier=db-g1-small \
  --region=us-west1 \
  --no-assign-ip \
  --network=default

# 2. Create both databases and users
gcloud sql databases create trapeze  --instance=trapeze-prod
gcloud sql databases create metabase --instance=trapeze-prod
gcloud sql users create trapeze_app  --instance=trapeze-prod --password=<generate>
gcloud sql users create metabase_app --instance=trapeze-prod --password=<generate>

# 3. Grant each user access to only their database (connect via Cloud SQL Auth Proxy)
psql "host=127.0.0.1 port=5432 user=postgres dbname=trapeze" \
  -c "GRANT ALL PRIVILEGES ON DATABASE trapeze TO trapeze_app;"
psql "host=127.0.0.1 port=5432 user=postgres dbname=metabase" \
  -c "GRANT ALL PRIVILEGES ON DATABASE metabase TO metabase_app;"

# 4. Export local dev Postgres and import to Cloud SQL
docker exec -i trapeze-postgres pg_dump -U test_intel test_intel > trapeze-dump.sql
gcloud sql import sql trapeze-prod gs://your-migration-bucket/trapeze-dump.sql --database=trapeze

# 5. Run Prisma migrations on the new instance
DATABASE_URL="postgresql://trapeze_app:<pass>@127.0.0.1:5432/trapeze" \
  npx prisma migrate deploy

# 6. Apply SQL analytics views (not part of Prisma migrations)
DATABASE_URL="postgresql://trapeze_app:<pass>@127.0.0.1:5432/trapeze" \
  npm run db:views

# Metabase initialises its own schema on first boot — no manual migration needed.
```

---

## 2. Cloud Storage

### Buckets

| Bucket                    | Purpose                                            | Lifecycle rules                                                                                            |
| ------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `evite-trapeze-drop-zone` | Incoming CI result files                           | Delete `incoming/` after 7 days; `processed/` after 30 days; `failed/` after 90 days                       |
| `evite-trapeze-artifacts` | Test artifacts (screenshots, videos, traces, logs) | Videos: delete after 30 days; screenshots/traces/logs: delete after 90 days; source XML/JSON: never delete |

Both buckets:

- Uniform bucket-level access (no per-object ACLs)
- Regional storage class, `us-west1`
- Public access prevention: enforced

```bash
# Create buckets
gcloud storage buckets create gs://evite-trapeze-drop-zone \
  --project=evite-production --location=us-west1 \
  --uniform-bucket-level-access

gcloud storage buckets create gs://evite-trapeze-artifacts \
  --project=evite-production --location=us-west1 \
  --uniform-bucket-level-access

# Apply lifecycle rules (after configuring real GCS credentials)
GCS_BUCKET=evite-trapeze-artifacts npm run storage:lifecycle
```

---

## 3. Jenkins ETL Agent Setup

The five Trapeze ETL pipelines run on a Jenkins agent with the `trapeze` label. This agent needs DB access (via Cloud SQL Auth Proxy) and GCS access (via service account key).

### Agent requirements

| Requirement             | Details                                                     |
| ----------------------- | ----------------------------------------------------------- |
| Node.js                 | v20.x (`nvm` or system install)                             |
| Cloud SQL Auth Proxy    | v2.x — connects Jenkins to Cloud SQL private IP             |
| GCS service account key | `trapeze-etl` SA with `storage.objectAdmin` on both buckets |
| Label                   | `trapeze` (Jenkinsfiles use `agent { label 'trapeze' }`)    |
| Network                 | Must reach GCP VPC via Private Service Connect or VPN       |
| Disk                    | ≥ 2 GB free for `node_modules` checkout per workspace       |

### Cloud SQL Auth Proxy setup (on the trapeze Jenkins agent)

The Auth Proxy runs as a background service on the Jenkins agent machine. It provides a local TCP socket that the app connects to as a normal Postgres connection.

```bash
# 1. Install Cloud SQL Auth Proxy (v2)
curl -o /usr/local/bin/cloud-sql-proxy \
  https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.13.0/cloud-sql-proxy.linux.amd64
chmod +x /usr/local/bin/cloud-sql-proxy

# 2. Create a systemd service so it starts automatically
cat > /etc/systemd/system/cloud-sql-proxy.service << 'EOF'
[Unit]
Description=Cloud SQL Auth Proxy for Trapeze
After=network.target

[Service]
ExecStart=/usr/local/bin/cloud-sql-proxy \
  --credentials-file=/opt/trapeze/trapeze-etl-key.json \
  evite-production:us-west1:trapeze-prod \
  --port=5432 \
  --address=127.0.0.1
Restart=always
User=jenkins

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cloud-sql-proxy
systemctl start cloud-sql-proxy

# 3. Verify the proxy is listening
pg_isready -h 127.0.0.1 -p 5432 -U trapeze_app
```

The `DATABASE_URL` for Jenkins credentials then becomes:

```
postgresql://trapeze_app:<password>@127.0.0.1:5432/trapeze
```

> **Alternative: if Jenkins is in the same GCP VPC as Cloud SQL**, you can skip the Auth Proxy entirely and use the Cloud SQL private IP directly in `DATABASE_URL`. Confirm the Jenkins agent subnet can reach the Cloud SQL private IP via VPC peering or Private Service Connect.

### Seeding Jenkins credentials and jobs

All Jenkins credentials and pipeline jobs are created in one idempotent script — no UI clicks required:

```bash
export JENKINS_URL="https://jenkins.evite.com"
export JENKINS_USER="admin"
export JENKINS_API_TOKEN="<api-token>"

export DATABASE_URL="postgresql://trapeze_app:<pass>@127.0.0.1:5432/trapeze"
export GCS_BUCKET="evite-trapeze-artifacts"
export GCS_PROJECT="evite-production"
export GCS_SA_KEY_PATH="/tmp/trapeze-etl-key.json"    # omit for Workload Identity

export JIRA_BASE_URL="https://evitetracking.atlassian.net"
export JIRA_EMAIL="automation@evite.com"
export JIRA_API_TOKEN="<jira-api-token>"

export TESTRAIL_BASE_URL="https://evite.testrail.io"
export TESTRAIL_EMAIL="automation@evite.com"
export TESTRAIL_API_TOKEN="<testrail-api-token>"

export TRAPEZE_REPO_URL="git@github.com:evite/results.git"

bash scripts/jenkins-seed-prod.sh
```

This creates:

| Jenkins credential ID        | Type        | Value                          |
| ---------------------------- | ----------- | ------------------------------ |
| `trapeze-db-url`             | Secret text | Full `DATABASE_URL`            |
| `trapeze-gcs-bucket`         | Secret text | `evite-trapeze-artifacts`      |
| `trapeze-gcs-project`        | Secret text | `evite-production`             |
| `trapeze-gcs-credentials`    | Secret file | `trapeze-etl` SA JSON key      |
| `trapeze-jira-base-url`      | Secret text | Jira base URL                  |
| `trapeze-jira-email`         | Secret text | Jira service account email     |
| `trapeze-jira-api-token`     | Secret text | Atlassian API token            |
| `trapeze-testrail-base-url`  | Secret text | TestRail base URL              |
| `trapeze-testrail-email`     | Secret text | TestRail service account email |
| `trapeze-testrail-api-token` | Secret text | TestRail API key               |

And creates/registers:

| Pipeline job                | Jenkinsfile                             | Schedule                      |
| --------------------------- | --------------------------------------- | ----------------------------- |
| `trapeze-sync-jira`         | `jenkins/Jenkinsfile.sync-jira`         | `H 6 * * *` (nightly ~6 AM)   |
| `trapeze-sync-testrail`     | `jenkins/Jenkinsfile.sync-testrail`     | `H 6 * * *` (nightly ~6 AM)   |
| `trapeze-snapshot-coverage` | `jenkins/Jenkinsfile.snapshot-coverage` | `H 7 * * *` (nightly ~7 AM)   |
| `trapeze-analyze-flakes`    | `jenkins/Jenkinsfile.analyze-flakes`    | `H 8 * * 1` (Monday ~8 AM)    |
| `trapeze-ingest-from-gcs`   | `jenkins/Jenkinsfile.ingest-from-gcs`   | `H/15 * * * *` (every 15 min) |
| `trapeze-push-testrail`     | `jenkins/Jenkinsfile.push-testrail`     | Manual / downstream trigger   |
| `trapeze` shared library    | `jenkins/vars/`                         | —                             |

### Job dependency order

The nightly jobs have a natural dependency order. Jenkins cron spreads them safely:

```
~6 AM  sync-jira + sync-testrail   (run in parallel — no dependency between them)
~7 AM  snapshot-coverage           (reads jira_issue populated by sync-jira)
~8 AM  analyze-flakes (Mondays)    (reads TestCaseResult / TestAttempt from ingests)
*/15m  ingest-from-gcs             (runs continuously — feeds data for all the above)
```

### Slack notifications

The shared library (`jenkins/vars/trapezeSlackNotify.groovy`) sends failure alerts (and success on nightly sync jobs) to a configured Slack webhook. Set the webhook URL as a Jenkins credential:

```bash
# Add to the seed script environment or create manually:
# Credential ID: trapeze-slack-webhook-url
# Type: Secret text
# Value: https://hooks.slack.com/services/T.../B.../...
```

---

## 4. Metabase on Cloud Run

Metabase is the only Trapeze component that is directly user-facing. It runs as a long-lived Cloud Run service.

### Cloud Run service definition

```yaml
# cloudrun/metabase.yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: trapeze-metabase
  annotations:
    run.googleapis.com/ingress: all
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "1" # always warm — no cold starts for users
        autoscaling.knative.dev/maxScale: "2"
        run.googleapis.com/cloudsql-instances: "evite-production:us-west1:trapeze-prod"
    spec:
      serviceAccountName: trapeze-metabase@evite-production.iam.gserviceaccount.com
      containers:
        - image: metabase/metabase:v0.50.3 # pin version — never use :latest in prod
          ports:
            - containerPort: 3000
          env:
            - name: MB_DB_TYPE
              value: postgres
            - name: MB_DB_DBNAME
              value: metabase
            - name: MB_DB_PORT
              value: "5432"
            - name: MB_DB_HOST
              value: "/cloudsql/evite-production:us-west1:trapeze-prod"
            - name: MB_DB_USER
              valueFrom:
                secretKeyRef:
                  name: metabase-db-user
                  key: latest
            - name: MB_DB_PASS
              valueFrom:
                secretKeyRef:
                  name: metabase-db-pass
                  key: latest
          resources:
            limits:
              memory: 1.5Gi
              cpu: "1"
```

### Deployment

```bash
gcloud run services replace cloudrun/metabase.yaml --region=us-west1
```

### Custom domain

```bash
gcloud run domain-mappings create \
  --service=trapeze-metabase \
  --domain=trapeze.evite.com \
  --region=us-west1
# SSL is provisioned automatically by Google.
```

Update DNS: add a CNAME from `trapeze.evite.com` → the Cloud Run service URL.

### Authentication — Google SSO

In Metabase Admin → Authentication → Google Sign-In:

1. Create an OAuth 2.0 Web Client in Google Cloud Console (APIs & Services → Credentials)
   - Authorized redirect URI: `https://trapeze.evite.com/auth/google/callback`
2. Paste the Client ID into Metabase
3. Set **Allowed email domains** to `evite.com`

Users authenticate with their existing Evite Google Workspace accounts — no separate passwords.

### Access groups (configure in Metabase Admin → People → Groups)

| Group             | Access                           | Who                        |
| ----------------- | -------------------------------- | -------------------------- |
| `QA Team`         | All dashboards + SQL editor      | QA engineers               |
| `Stakeholders`    | Read-only dashboards, no raw SQL | Product, engineering leads |
| `Metabase Admins` | Full admin                       | QA platform team           |

### Dashboard setup

After Metabase is running and connected to the `trapeze` database:

```bash
METABASE_URL=https://trapeze.evite.com \
METABASE_USER=admin@evite.com \
METABASE_PASSWORD=<initial-admin-password> \
npm run mb:setup
```

This creates all three dashboards (Coverage Overview, Suite Health & Flakes, Link Governance) automatically.

---

## 5. IAM / Service Accounts

| Service account                                                | Roles                                             | Used by                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `trapeze-etl@evite-production.iam.gserviceaccount.com`         | `storage.objectAdmin` on both GCS buckets         | Jenkins `trapeze`-labeled agent — GCS read/write for ingest and artifact storage |
| `trapeze-metabase@evite-production.iam.gserviceaccount.com`    | `cloudsql.client`, `secretmanager.secretAccessor` | Metabase Cloud Run service                                                       |
| `trapeze-ci-uploader@evite-production.iam.gserviceaccount.com` | `storage.objectCreator` on drop-zone bucket only  | Test execution agents (Playwright, Selenium) — write-only access to drop zone    |

> **Note:** The `trapeze-etl` service account does **not** need `cloudsql.client` because the Jenkins ETL agent connects to Cloud SQL via the Auth Proxy using its own service account key (set in the proxy's `--credentials-file`). If your Jenkins agent runs in GCP with Workload Identity, attach the `trapeze-etl` SA to the node instead of using a key file.

```bash
# Create service accounts
gcloud iam service-accounts create trapeze-etl       --display-name="Trapeze ETL Agent"
gcloud iam service-accounts create trapeze-metabase  --display-name="Trapeze Metabase"
gcloud iam service-accounts create trapeze-ci-uploader --display-name="Trapeze CI Uploader"

# ETL: Cloud SQL Auth Proxy (needs cloudsql.client to open the proxy connection)
gcloud projects add-iam-policy-binding evite-production \
  --member="serviceAccount:trapeze-etl@evite-production.iam.gserviceaccount.com" \
  --role="roles/cloudsql.client"

# ETL: GCS full access on both buckets
gcloud storage buckets add-iam-policy-binding gs://evite-trapeze-drop-zone \
  --member="serviceAccount:trapeze-etl@evite-production.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
gcloud storage buckets add-iam-policy-binding gs://evite-trapeze-artifacts \
  --member="serviceAccount:trapeze-etl@evite-production.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"

# Metabase: Cloud SQL + Secret Manager
gcloud projects add-iam-policy-binding evite-production \
  --member="serviceAccount:trapeze-metabase@evite-production.iam.gserviceaccount.com" \
  --role="roles/cloudsql.client"
gcloud projects add-iam-policy-binding evite-production \
  --member="serviceAccount:trapeze-metabase@evite-production.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# CI uploader: drop-zone write-only
gcloud storage buckets add-iam-policy-binding gs://evite-trapeze-drop-zone \
  --member="serviceAccount:trapeze-ci-uploader@evite-production.iam.gserviceaccount.com" \
  --role="roles/storage.objectCreator"

# Download key files
gcloud iam service-accounts keys create trapeze-etl-key.json \
  --iam-account=trapeze-etl@evite-production.iam.gserviceaccount.com

gcloud iam service-accounts keys create trapeze-ci-uploader-key.json \
  --iam-account=trapeze-ci-uploader@evite-production.iam.gserviceaccount.com
```

---

## 6. Secret Manager (Metabase only)

Jenkins holds its own credentials in the Jenkins credentials store (seeded by `jenkins-seed-prod.sh`). Secret Manager is only needed for the **Metabase Cloud Run service**, which cannot read from Jenkins.

```bash
# Create secrets for Metabase
echo -n "metabase_app" | gcloud secrets create metabase-db-user \
  --data-file=- --project=evite-production
echo -n "<metabase_app_password>" | gcloud secrets create metabase-db-pass \
  --data-file=- --project=evite-production

# Grant Metabase SA read access
gcloud secrets add-iam-policy-binding metabase-db-user \
  --member="serviceAccount:trapeze-metabase@evite-production.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding metabase-db-pass \
  --member="serviceAccount:trapeze-metabase@evite-production.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

---

## 7. CI Agent Integration

Test execution agents (Selenium, Playwright) upload result files to the GCS drop zone. They need only the `trapeze-ci-uploader` service account key — no DB access.

On each test execution Jenkins agent:

```bash
# 1. Place the key file somewhere Jenkins can read it
sudo mkdir -p /opt/trapeze
sudo cp trapeze-ci-uploader-key.json /opt/trapeze/gcs-uploader-key.json
sudo chown jenkins:jenkins /opt/trapeze/gcs-uploader-key.json
sudo chmod 600 /opt/trapeze/gcs-uploader-key.json

# 2. Add to /opt/trapeze/.env (loaded by trapeze-push.sh)
echo "GOOGLE_APPLICATION_CREDENTIALS=/opt/trapeze/gcs-uploader-key.json" >> /opt/trapeze/.env
echo "TRAPEZE_GCS_BUCKET=evite-trapeze-drop-zone" >> /opt/trapeze/.env
echo "TRAPEZE_GCS_PROJECT=evite-production" >> /opt/trapeze/.env
# Remove the emulator host line if it was set for local dev:
# GCS_EMULATOR_HOST=  <-- delete this line
```

Test jobs call `bash trapeze-push.sh` after collecting results — see `jenkins/README.md` for the Jenkinsfile snippet.

---

## 8. Networking

| Connection                            | Mechanism                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Jenkins ETL agent → Cloud SQL         | Cloud SQL Auth Proxy (TCP socket on `127.0.0.1:5432`) or direct private IP if agent is in same GCP VPC |
| Metabase Cloud Run → Cloud SQL        | Cloud SQL Auth Proxy sidecar (via `run.googleapis.com/cloudsql-instances` annotation)                  |
| Jenkins ETL agent → GCS               | Public internet, authenticated via `trapeze-etl` SA key                                                |
| Test execution agents → GCS drop zone | Public internet, authenticated via `trapeze-ci-uploader` SA key                                        |
| Employees → Metabase                  | Public HTTPS Cloud Run endpoint, Google SSO                                                            |

Cloud SQL has no public IP. Jenkins ETL agents that live outside GCP need a route to Cloud SQL:

- **Option A (preferred):** Install Cloud SQL Auth Proxy on the Jenkins agent machine (see Section 3)
- **Option B:** If Jenkins runs in GCP (Compute Engine / GKE), ensure it's in a VPC with Private Service Connect to the Cloud SQL VPC network

---

## 9. Cost Estimate (monthly)

| Component                            | Tier               | Estimated cost    |
| ------------------------------------ | ------------------ | ----------------- |
| Cloud SQL (db-g1-small)              | Always on          | ~$25              |
| Cloud Run: Metabase (1 min instance) | Always warm        | ~$35–50           |
| Cloud Storage                        | ~50 GB artifacts   | ~$1–2             |
| Secret Manager                       | 2 Metabase secrets | Free tier         |
| **Total**                            |                    | **~$60–75/month** |

ETL jobs run on your existing Jenkins infrastructure at no additional GCP cost. This is ~$5–10/month cheaper than the Cloud Run Jobs + Cloud Scheduler approach, plus no container image build/push pipeline needed.

---

## 10. Migration Checklist

### Phase 1 — GCP resources

- [ ] Provision Cloud SQL instance `trapeze-prod` (private IP, `us-west1`, `db-g1-small`)
- [ ] Create `trapeze` and `metabase` databases; create `trapeze_app` and `metabase_app` users
- [ ] Export local Postgres → upload to a migration GCS bucket → import to Cloud SQL
- [ ] Run `prisma migrate deploy` against Cloud SQL
- [ ] Run `npm run db:views` against Cloud SQL to apply analytics views
- [ ] Create GCS buckets (`evite-trapeze-drop-zone`, `evite-trapeze-artifacts`)
- [ ] Apply GCS lifecycle rules: `GCS_BUCKET=evite-trapeze-artifacts npm run storage:lifecycle`
- [ ] Create service accounts: `trapeze-etl`, `trapeze-metabase`, `trapeze-ci-uploader`
- [ ] Assign IAM roles per Section 5
- [ ] Download `trapeze-etl-key.json` and `trapeze-ci-uploader-key.json`
- [ ] Create Secret Manager secrets for Metabase DB credentials (Section 6)

### Phase 2 — Jenkins ETL agent

- [ ] Identify (or provision) the Jenkins agent that will carry the `trapeze` label
- [ ] Install Node.js v20 on that agent
- [ ] Install Cloud SQL Auth Proxy v2 on that agent (Section 3)
- [ ] Place `trapeze-etl-key.json` at `/opt/trapeze/trapeze-etl-key.json` on the agent
- [ ] Start and enable the `cloud-sql-proxy` systemd service; verify `pg_isready` passes
- [ ] Run `bash scripts/jenkins-seed-prod.sh` to create all credentials and pipeline jobs
- [ ] Verify all 5 pipeline jobs appear in Jenkins and have their cron triggers set
- [ ] Manually trigger `trapeze-sync-jira` and confirm it completes without errors
- [ ] Manually trigger `trapeze-ingest-from-gcs` and confirm it drains the (empty) drop zone

### Phase 3 — Metabase

- [ ] Deploy Metabase to Cloud Run: `gcloud run services replace cloudrun/metabase.yaml --region=us-west1`
- [ ] Wait for Cloud Run startup (~2 min); hit the Cloud Run URL and confirm Metabase loads
- [ ] Create `metabase` database user grant (Section 1) — Metabase will auto-migrate its schema on first boot
- [ ] Run `npm run mb:setup` pointing at the Cloud Run Metabase URL
- [ ] In Metabase Admin: connect to the `trapeze` database on Cloud SQL
- [ ] Configure Google SSO (OAuth 2.0 client → restrict to `evite.com`)
- [ ] Create user groups and assign permissions
- [ ] Map custom domain: `gcloud run domain-mappings create ... --domain=trapeze.evite.com`
- [ ] Update DNS CNAME; wait for SSL cert provisioning (usually <15 min)
- [ ] Verify all three dashboards load at `https://trapeze.evite.com`

### Phase 4 — CI agent integration and smoke test

- [ ] Place `trapeze-ci-uploader-key.json` on each test execution Jenkins agent (Section 7)
- [ ] Update `/opt/trapeze/.env` on each agent: remove `GCS_EMULATOR_HOST`, set production `GCS_BUCKET=evite-trapeze-drop-zone`
- [ ] Run a Playwright acceptance build; confirm result files land in `evite-trapeze-drop-zone/incoming/`
- [ ] Confirm `trapeze-ingest-from-gcs` picks them up within 15 minutes
- [ ] Check Metabase Suite Health dashboard — new run should appear
- [ ] Transfer repo from `jcpeters/results` → `evite/results` and update `TRAPEZE_REPO_URL` in Jenkins jobs
- [ ] Rotate any API tokens that were used during development

---

## 11. What Changes for Developers

Local development is **unchanged** — `fake-gcs-server`, local Postgres, and `localhost:3000` Metabase continue to work exactly as today.

The only production-specific differences:

- `GCS_EMULATOR_HOST` is absent from production `.env` — this flag alone controls local vs real GCS
- `DATABASE_URL` points to `127.0.0.1:5432` via Cloud SQL Auth Proxy (on the ETL agent) or direct private IP
- Jenkins credentials store holds production secrets instead of `.env` file
