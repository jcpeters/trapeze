#!/usr/bin/env bash
# trapeze-push.sh
#
# CI-side script that uploads test result files to the Trapeze GCS drop zone.
# Works with both legacy freestyle Jenkins jobs and modern declarative pipelines.
#
# This script intentionally exits 0 in all cases — a Trapeze upload failure
# should never fail the CI build.
#
# ── Quick start (add to the end of your build shell step) ────────────────────
#
#   Selenium / pytest (JUnit XML):
#     bash $TRAPEZE_HOME/scripts/trapeze-push.sh \
#       --framework pytest \
#       --result-file $WORKSPACE/webdriver-framework/logs/$BUILD_NUMBER.xml \
#       --environment $ENV
#
#   Playwright (JSON reporter):
#     bash $TRAPEZE_HOME/scripts/trapeze-push.sh \
#       --framework playwright \
#       --result-file $WORKSPACE/playwright-report/results.json \
#       --artifacts-dir $WORKSPACE/test-results \
#       --environment acceptance
#
# ── Jenkins env vars read automatically ──────────────────────────────────────
#   $JOB_NAME      → --job
#   $BUILD_NUMBER  → --build
#   $BUILD_URL     → --build-url
#   $GIT_COMMIT    → --git-sha
#   $GIT_BRANCH    → --branch   (origin/ prefix stripped automatically)
#
# ── Required on each Jenkins agent ───────────────────────────────────────────
#   TRAPEZE_HOME   env var pointing to a checkout of the trapeze repo
#                  (e.g. /opt/trapeze).  The trapeze repo must have had
#                  `npm ci` run inside it at least once.
#   Node.js 20+    on PATH
#   GCS_BUCKET     env var (or set in .env inside TRAPEZE_HOME)
#
# ── Optional env vars ─────────────────────────────────────────────────────────
#   TRAPEZE_DRY_RUN=1   Print what would be uploaded without writing to GCS.
#   TRAPEZE_EXPLAIN=1   Verbose logging.
# ─────────────────────────────────────────────────────────────────────────────

set -uo pipefail

# ── Defaults from Jenkins-injected env vars ───────────────────────────────────
TRAPEZE_HOME="${TRAPEZE_HOME:-/opt/trapeze}"
JOB="${JOB_NAME:-unknown-job}"
BUILD="${BUILD_NUMBER:-0}"
BUILD_URL_VAL="${BUILD_URL:-}"
GIT_SHA="${GIT_COMMIT:-}"
BRANCH="${GIT_BRANCH:-}"

# Strip "origin/" prefix that Jenkins SCM adds (e.g. origin/main → main)
BRANCH="${BRANCH#origin/}"

# ── Flags ─────────────────────────────────────────────────────────────────────
FRAMEWORK=""
RESULT_FILE=""
ENVIRONMENT="acceptance"
ARTIFACTS_DIR=""
DRY_RUN="${TRAPEZE_DRY_RUN:-}"
EXPLAIN="${TRAPEZE_EXPLAIN:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --framework)     FRAMEWORK="$2";     shift 2 ;;
    --result-file)   RESULT_FILE="$2";   shift 2 ;;
    --environment)   ENVIRONMENT="$2";   shift 2 ;;
    --artifacts-dir) ARTIFACTS_DIR="$2"; shift 2 ;;
    --job)           JOB="$2";           shift 2 ;;
    --build)         BUILD="$2";         shift 2 ;;
    --branch)        BRANCH="$2";        shift 2 ;;
    --git-sha)       GIT_SHA="$2";       shift 2 ;;
    --build-url)     BUILD_URL_VAL="$2"; shift 2 ;;
    --dry-run)       DRY_RUN=1;          shift ;;
    --explain)       EXPLAIN=1;          shift ;;
    *) echo "[trapeze] Unknown argument: $1" >&2; shift ;;
  esac
done

# ── Preflight checks ──────────────────────────────────────────────────────────

_skip() {
  echo "[trapeze] SKIP: $1" >&2
  exit 0
}

_warn() {
  echo "[trapeze] WARN: $1" >&2
}

if [[ -z "$RESULT_FILE" ]]; then
  _skip "--result-file is required"
fi

if [[ -z "$FRAMEWORK" ]]; then
  _skip "--framework is required (pytest | playwright | junit)"
fi

if [[ ! -f "$RESULT_FILE" ]]; then
  _warn "Result file not found: $RESULT_FILE"
  _skip "Skipping upload — test step may have failed before producing output"
fi

if [[ ! -d "$TRAPEZE_HOME" ]]; then
  _warn "TRAPEZE_HOME not found at: $TRAPEZE_HOME"
  _skip "Set TRAPEZE_HOME to the trapeze repo checkout on this agent"
fi

TSX_BIN="$TRAPEZE_HOME/node_modules/.bin/tsx"
UPLOAD_SCRIPT="$TRAPEZE_HOME/scripts/upload-to-drop-zone.ts"

if [[ ! -f "$TSX_BIN" ]]; then
  _warn "tsx not found at $TSX_BIN — run 'npm ci' inside $TRAPEZE_HOME first"
  _skip "Missing dependencies"
fi

if [[ ! -f "$UPLOAD_SCRIPT" ]]; then
  _skip "upload-to-drop-zone.ts not found at $UPLOAD_SCRIPT — check TRAPEZE_HOME"
fi

# ── Build argument list ───────────────────────────────────────────────────────

UPLOAD_ARGS=(
  "--file"        "$RESULT_FILE"
  "--job"         "$JOB"
  "--build"       "$BUILD"
  "--framework"   "$FRAMEWORK"
  "--ci-provider" "jenkins"
  "--environment" "$ENVIRONMENT"
)

[[ -n "$GIT_SHA"        ]] && UPLOAD_ARGS+=("--git-sha"    "$GIT_SHA")
[[ -n "$BRANCH"         ]] && UPLOAD_ARGS+=("--branch"     "$BRANCH")
[[ -n "$BUILD_URL_VAL"  ]] && UPLOAD_ARGS+=("--build-url"  "$BUILD_URL_VAL")
[[ -n "$DRY_RUN"        ]] && UPLOAD_ARGS+=("--dry-run")
[[ -n "$EXPLAIN"        ]] && UPLOAD_ARGS+=("--explain")

if [[ -n "$ARTIFACTS_DIR" ]]; then
  if [[ -d "$ARTIFACTS_DIR" ]]; then
    UPLOAD_ARGS+=("--artifacts-dir" "$ARTIFACTS_DIR")
  else
    _warn "artifacts-dir not found: $ARTIFACTS_DIR — skipping artifact upload"
  fi
fi

# ── Run ───────────────────────────────────────────────────────────────────────

echo "[trapeze] Uploading $FRAMEWORK results → drop zone (job=$JOB build=$BUILD)"

# Load .env from TRAPEZE_HOME if present (picks up GCS_BUCKET, GCS_EMULATOR_HOST, etc.)
# Uses default-only semantics: variables already set in the environment (e.g. Docker
# container env vars injected by docker-compose) are NOT overridden. This ensures that
# GCS_EMULATOR_HOST=fake-gcs:4443 set by docker-compose is preserved even when the
# host-side .env file contains GCS_EMULATOR_HOST=localhost:4443.
ENV_FILE="$TRAPEZE_HOME/.env"
if [[ -f "$ENV_FILE" ]]; then
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    # Skip comments and blank lines
    [[ "$key" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${key// }" ]] && continue
    # Only export the value if the variable is not already set
    [[ -z "${!key+x}" ]] && export "$key=$value"
  done < "$ENV_FILE"
fi

"$TSX_BIN" "$UPLOAD_SCRIPT" "${UPLOAD_ARGS[@]}" || {
  _warn "Upload failed — results will not appear in Trapeze for this build"
  exit 0
}

# Always exit 0 — trapeze must never fail the CI build
exit 0
