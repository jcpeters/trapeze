# Trapeze — Production Deployment Plan

Target cloud: **Google Cloud Platform (GCP)**

---

## Architecture Overview

```
                        ┌─────────────────────────────────────────────────┐
                        │                   GCP Project                    │
                        │                                                   │
  Evite employees ──────►  Cloud Run: Metabase  ◄──── @evite.com Google SSO│
  (browser, any network)│       (always-on)      │                         │
                        │           │             │                         │
  Jenkins agents ───────►  Cloud Storage (GCS)   │                         │
  (upload only, no DB)  │   drop zone bucket     │                         │
                        │           │             │                         │
                        │  Cloud Run Jobs (ETL)   │                         │
                        │  ingest / sync / analyze◄──── Cloud Scheduler    │
                        │           │             │                         │
                        │           ▼             │                         │
                        │     Cloud SQL           │                         │
                        │  (Postgres 16, private IP)                        │
                        └─────────────────────────────────────────────────┘
```

### Services

| Service | GCP Product | Purpose |
|---------|------------|---------|
| Postgres database | Cloud SQL (Postgres 16) | All metadata — builds, executions, links, coverage |
| Metabase dashboards | Cloud Run (always-on) | Stakeholder-facing dashboard UI |
| ETL jobs | Cloud Run Jobs | Sync, ingest, analysis — triggered by Cloud Scheduler |
| Artifact / result file storage | Cloud Storage | JUnit XML, Playwright JSON, screenshots, videos, traces |
| Secret storage | Secret Manager | DATABASE_URL, API tokens, GCS bucket name |
| Networking | VPC + Private Service Connect | Cloud SQL on private IP; no public DB exposure |

---

## 1. Cloud SQL

### Instance config

One Cloud SQL instance hosts **two databases** — `trapeze` (app data) and `metabase` (Metabase internal config). This avoids paying the ~$25/month base cost twice.

```
Database engine : PostgreSQL 16
Instance name   : trapeze-prod
Instance tier   : db-g1-small (1 vCPU, 1.7 GB RAM) — sufficient for current load
                  Upgrade to db-custom-2-7680 if query latency becomes noticeable
Region          : us-west1 (same as Cloud Run to minimise latency)
Connectivity    : Private IP only (no public IP)
Storage         : 20 GB SSD, auto-growth enabled
Backups         : Automated daily, 7-day retention
```

### Databases and users

| Database | User | Used by | Connection |
|----------|------|---------|------------|
| `trapeze` | `trapeze_app` | ETL jobs, ingest scripts | `DATABASE_URL` in Secret Manager |
| `metabase` | `metabase_app` | Metabase internal config (dashboards, users, questions) | `MB_DB_*` env vars on Cloud Run |

Each user only has access to its own database — `trapeze_app` cannot read `metabase` and vice versa.

### Migration from local dev

```bash
# 1. Export local Postgres (from Docker)
docker exec -i trapeze-postgres pg_dump -U test_intel test_intel > trapeze-dump.sql

# 2. Create Cloud SQL instance
gcloud sql instances create trapeze-prod --database-version=POSTGRES_16 --tier=db-g1-small --region=us-west1 --no-assign-ip --network=default

# 3. Create both databases and users
gcloud sql databases create trapeze --instance=trapeze-prod
gcloud sql databases create metabase --instance=trapeze-prod
gcloud sql users create trapeze_app --instance=trapeze-prod --password=<generate>
gcloud sql users create metabase_app --instance=trapeze-prod --password=<generate>

# 4. Grant each user access to only their database (connect via Cloud SQL Auth Proxy)
psql "host=127.0.0.1 port=5432 user=postgres dbname=trapeze" -c "GRANT ALL PRIVILEGES ON DATABASE trapeze TO trapeze_app;"
psql "host=127.0.0.1 port=5432 user=postgres dbname=metabase" -c "GRANT ALL PRIVILEGES ON DATABASE metabase TO metabase_app;"

# 5. Import Trapeze dump
gcloud sql import sql trapeze-prod gs://your-migration-bucket/trapeze-dump.sql --database=trapeze

# 6. Run Prisma migrations on the new instance
DATABASE_URL="postgresql://trapeze_app:<pass>@/trapeze?host=/cloudsql/PROJECT:us-west1:trapeze-prod" npx prisma migrate deploy

# Metabase will initialise its own schema on first boot — no manual migration needed.
```

---

## 2. Cloud Storage

### Buckets

| Bucket | Purpose | Lifecycle rules |
|--------|---------|-----------------|
| `evite-trapeze-drop-zone` | Incoming CI result files | Delete `incoming/` after 7 days; `processed/` after 30 days; `failed/` after 90 days |
| `evite-trapeze-artifacts` | Test artifacts (screenshots, videos, traces, logs) | Videos: delete after 30 days; screenshots/traces/logs: delete after 90 days; source XML/JSON: never delete |

Both buckets should have:
- Uniform bucket-level access (no per-object ACLs)
- Regional storage class, `us-west1`
- Public access prevention: enforced

Apply lifecycle rules (once real GCS is configured):

```bash
npm run storage:lifecycle
```

---

## 3. Metabase on Cloud Run

Metabase runs as a long-lived container service — the only Trapeze component that is directly user-facing.

### Container

Metabase publishes an official Docker image: `metabase/metabase:latest` (pin to a specific version in production, e.g. `v0.50.x`).

Metabase requires its own internal Postgres database to store dashboard definitions, user accounts, and question history. This uses the `metabase` database on the same `trapeze-prod` Cloud SQL instance — no second instance needed.

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
        autoscaling.knative.dev/minScale: "1"   # always warm — no cold starts for users
        autoscaling.knative.dev/maxScale: "2"
        run.googleapis.com/cloudsql-instances: "PROJECT:us-west1:trapeze-prod"
    spec:
      containers:
        - image: metabase/metabase:v0.50.3
          ports:
            - containerPort: 3000
          env:
            - name: MB_DB_TYPE
              value: postgres
            - name: MB_DB_DBNAME
              value: metabase
            - name: MB_DB_PORT
              value: "5432"
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
            - name: MB_DB_HOST
              value: "/cloudsql/PROJECT:us-west1:trapeze-prod"
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

Map `trapeze.evite.com` (or `trapeze-internal.evite.com`) to the Cloud Run service:

```bash
gcloud run domain-mappings create --service=trapeze-metabase --domain=trapeze.evite.com --region=us-west1
```

SSL is provisioned automatically by Google.

### Authentication — Google SSO

In Metabase Admin → Authentication → Google Sign-In:
- Enable Google Sign-In
- Client ID: create an OAuth 2.0 client in Google Cloud Console for `trapeze.evite.com`
- Restrict to `@evite.com` domain

Users authenticate with their existing Evite Google Workspace accounts — no separate passwords.

### Access groups (configure in Metabase Admin → People → Groups)

| Group | Access | Who |
|-------|--------|-----|
| `QA Team` | All dashboards + SQL editor | QA engineers |
| `Stakeholders` | Read-only dashboards, no raw SQL | Product, engineering leads |
| `Metabase Admins` | Full admin | QA platform team |

---

## 4. ETL Jobs on Cloud Run Jobs + Cloud Scheduler

Replace the Jenkins-scheduled ETL jobs with Cloud Run Jobs triggered by Cloud Scheduler. This removes the dependency on Jenkins having DB access.

> **Note:** If you prefer to keep ETL scheduling in Jenkins (e.g. for centralised job history), the Jenkins Jenkinsfiles in `jenkins/` can continue to be used — just point them at the Cloud SQL `DATABASE_URL`. The Cloud Run Jobs approach is the fully cloud-native alternative.

### Job definitions

Each ETL script becomes a Cloud Run Job:

| Job name | npm script | Schedule (Cloud Scheduler) | Region |
|----------|-----------|---------------------------|--------|
| `trapeze-sync-jira` | `etl:sync:jira` | `0 6 * * *` | us-west1 |
| `trapeze-sync-testrail` | `etl:sync:testrail` | `0 6 * * *` | us-west1 |
| `trapeze-snapshot-coverage` | `etl:snapshot:coverage` | `0 7 * * *` | us-west1 |
| `trapeze-analyze-flakes` | `analyze:flakes` | `0 8 * * 1` | us-west1 |
| `trapeze-ingest-from-gcs` | `etl:ingest:from-gcs` | `*/15 * * * *` | us-west1 |

### Container image

A single Docker image serves all ETL jobs — the entrypoint changes per job:

```dockerfile
# Dockerfile.etl (to be created)
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npx prisma generate
ENTRYPOINT ["node", "--import=tsx/esm"]
```

Each Cloud Run Job overrides the command:

```bash
# Example: create the ingest-from-gcs job
gcloud run jobs create trapeze-ingest-from-gcs \
  --image=us-west1-docker.pkg.dev/PROJECT/trapeze/etl:latest \
  --command="node" \
  --args="--import=tsx/esm,scripts/ingest-from-gcs.ts" \
  --set-secrets="DATABASE_URL=trapeze-db-url:latest,GCS_BUCKET=trapeze-gcs-bucket:latest" \
  --service-account=trapeze-etl@PROJECT.iam.gserviceaccount.com \
  --region=us-west1
```

### Secrets via Secret Manager

All credentials stored in Secret Manager — no `.env` files in production:

| Secret name | Value |
|-------------|-------|
| `trapeze-db-url` | `postgresql://trapeze_app:<pass>@<private-ip>/trapeze` |
| `trapeze-jira-base-url` | `https://evite.atlassian.net` |
| `trapeze-jira-email` | Jira service account email |
| `trapeze-jira-api-token` | Atlassian API token |
| `trapeze-testrail-base-url` | `https://evite.testrail.io` |
| `trapeze-testrail-email` | TestRail service account email |
| `trapeze-testrail-api-token` | TestRail API key |
| `trapeze-gcs-bucket` | `evite-trapeze-artifacts` |
| `metabase-db-user` | Metabase internal DB username |
| `metabase-db-pass` | Metabase internal DB password |

---

## 5. IAM / Service Accounts

| Service account | Roles | Used by |
|-----------------|-------|---------|
| `trapeze-etl@PROJECT.iam.gserviceaccount.com` | `cloudsql.client`, `storage.objectAdmin`, `secretmanager.secretAccessor` | Cloud Run ETL jobs |
| `trapeze-metabase@PROJECT.iam.gserviceaccount.com` | `cloudsql.client`, `secretmanager.secretAccessor` | Metabase Cloud Run service |
| `trapeze-ci-uploader@PROJECT.iam.gserviceaccount.com` | `storage.objectCreator` on drop zone bucket only | Jenkins test execution agents |

The CI uploader account has the minimum possible permissions — it can only write new objects to the drop zone bucket. It cannot read the DB, read existing GCS objects, or access any other GCP service.

Download the CI uploader key and distribute to Jenkins agents:

```bash
gcloud iam service-accounts keys create trapeze-ci-uploader-key.json \
  --iam-account=trapeze-ci-uploader@PROJECT.iam.gserviceaccount.com
```

Set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/trapeze-ci-uploader-key.json` in `/opt/trapeze/.env` on each test execution agent.

---

## 6. Networking

- Cloud SQL: **private IP only**, connected via Private Service Connect or Cloud SQL Auth Proxy sidecar on Cloud Run Jobs
- GCS: accessible over public internet with service account auth (no VPC needed)
- Metabase Cloud Run: public HTTPS endpoint, auth via Google SSO — no VPN required for end users
- Jenkins agents → GCS: public internet upload (service account key auth)

---

## 7. Cost Estimate (monthly)

| Component | Tier | Estimated cost |
|-----------|------|----------------|
| Cloud SQL (db-g1-small) | Always on | ~$25 |
| Cloud Run: Metabase (1 min instance) | Always warm | ~$35–50 |
| Cloud Run Jobs: ETL | ~50 executions/day, <5 min each | ~$5 |
| Cloud Storage | ~50 GB artifacts | ~$1–2 |
| Cloud Scheduler | 5 jobs | Free tier |
| Secret Manager | ~10 secrets | Free tier |
| **Total** | | **~$65–80/month** |

---

## 8. Migration Checklist

- [ ] Create GCP project (or use existing `evite-production`)
- [ ] Provision Cloud SQL instance (`trapeze-prod`)
- [ ] Export local Postgres and import to Cloud SQL
- [ ] Run `prisma migrate deploy` against Cloud SQL
- [ ] Create GCS buckets (`evite-trapeze-drop-zone`, `evite-trapeze-artifacts`)
- [ ] Apply GCS lifecycle rules (`npm run storage:lifecycle`)
- [ ] Create service accounts and assign IAM roles
- [ ] Store all credentials in Secret Manager
- [ ] Build and push ETL container image to Artifact Registry
- [ ] Deploy Cloud Run Jobs for each ETL script
- [ ] Create Cloud Scheduler triggers for each job
- [ ] Deploy Metabase to Cloud Run
- [ ] Create `metabase` database and `metabase_app` user on the same `trapeze-prod` Cloud SQL instance
- [ ] Run `npm run mb:setup` pointing at production Metabase URL
- [ ] Configure Google SSO in Metabase Admin
- [ ] Create Metabase user groups and permissions
- [ ] Map custom domain (`trapeze.evite.com`) to Metabase Cloud Run service
- [ ] Distribute CI uploader service account key to Jenkins test execution agents
- [ ] Update `TRAPEZE_HOME/.env` on agents: remove `GCS_EMULATOR_HOST`, set production `GCS_BUCKET`
- [ ] Run one end-to-end smoke test: simulate-build → drop zone → ingest → Metabase dashboard
- [ ] Transfer repo from `jcpeters/trapeze` to `evite/trapeze`
- [ ] Rotate any API tokens exposed during development

---

## 9. What Changes for Developers

Local development is unchanged — `fake-gcs-server`, local Postgres, and `localhost:3000` Metabase continue to work exactly as today. The only difference is that production credentials live in Secret Manager instead of `.env`.

The `.env` file on developer machines keeps `GCS_EMULATOR_HOST=localhost:4443` — this is the only flag that controls local vs. production GCS routing.
