# ADR 0010: Fake GCS Emulator for Local Development (No Mocks)

- **Date:** 2026-03-24
- **Author:** Joe Peters
- **Status:** Accepted

## Context

Trapeze's ingest and upload scripts interact with Google Cloud Storage for drop zone operations, artifact storage, and signed URL generation. Developers need to run and test these scripts locally without GCP credentials and without risk of affecting production buckets.

Three approaches were considered:

1. **SDK mocking** — intercept GCS SDK calls with test doubles (e.g., `jest.mock`, `sinon.stub`)
2. **Real GCS bucket in development** — developers configure a personal GCS bucket in `.env`
3. **Local GCS emulator** — run a container that implements the GCS HTTP API locally

## Decision

Use **`fsouza/fake-gcs-server`** as a Docker Compose service that implements the GCS JSON and XML APIs locally on port 4443.

A **single conditional** in `scripts/storage.ts` routes all GCS operations:

```typescript
if (env.GCS_EMULATOR_HOST) {
  // point SDK at http://fake-gcs:4443
} else {
  // use real GCS with application default credentials
}
```

No other code branching exists. The same `uploadFile`, `signedUrl`, and lifecycle policy calls that run in production execute against the emulator in local dev. The emulator state persists in a named Docker volume (`gcsdata_test_intel`) across restarts.

The GCS emulator starts automatically with `docker compose up` (no `--profile` flag needed).

## Consequences

**Positive:**

- **Code path parity:** every code path that runs in production runs locally, including error handling, retry logic, and lifecycle rule application
- **Early bug detection:** GCS authentication errors, key structure mistakes, and lifecycle rule conflicts surface before deployment
- **Zero credentials:** developers do not need a GCP service account for local development; no risk of accidentally writing to or deleting from production buckets
- **Offline development:** no external API dependency; works on an airplane or behind a restrictive firewall
- **Docker-native:** integrates cleanly with the existing Postgres and Metabase containers in `docker-compose.yml`

**Negative:**

- **Behavioral drift:** `fake-gcs-server` may not implement every GCS API feature (e.g., uniform bucket-level access, specific IAM condition expressions, Pub/Sub notifications)
- **Version lag:** if the real GCS API changes, the emulator may not reflect the change for several months
- **Signed URL format difference:** emulator signed URLs use `localhost:4443`; production uses `storage.googleapis.com` — developers cannot test signed URL consumption against the emulator without additional proxy configuration

**Mitigations:**

- Pre-deployment smoke test against real GCS in a staging environment catches emulator/production behavioral differences before they reach production
- `fake-gcs-server` is actively maintained and covers all API surface area used by Trapeze (upload, download, list, delete, lifecycle, signed URLs)
- The signed URL issue affects only URL format, not content; ingest scripts download artifacts using the GCS SDK directly (not via signed URLs), so this does not affect any current code paths
