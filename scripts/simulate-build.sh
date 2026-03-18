#!/usr/bin/env bash
# simulate-build.sh
#
# Simulates a Jenkins pipeline uploading result files to the Trapeze
# GCS drop zone — without needing a Jenkins server.
#
# Use this to test the full ingest cycle locally:
#   1. Upload → GCS drop zone (fake-gcs-server)
#   2. Run ingest-from-gcs.ts to drain the drop zone into Postgres
#
# Usage:
#   ./scripts/simulate-build.sh <result-file> [options]
#
# Examples:
#   # Selenium / pytest (JUnit XML)
#   ./scripts/simulate-build.sh junit_xml/my-results.xml \
#       --job qa-evite-test-tests-acceptance \
#       --build 9999 \
#       --framework pytest \
#       --branch main \
#       --environment acceptance
#
#   # Playwright JSON
#   ./scripts/simulate-build.sh junit_json/pw-results.json \
#       --job qa-evite-playwright-acceptance \
#       --build 9999 \
#       --framework playwright \
#       --environment acceptance
#
#   # Then drain the drop zone:
#   npm run etl:ingest:from-gcs -- --explain

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Defaults ──────────────────────────────────────────────────────────────────
RESULT_FILE=""
JOB_NAME="simulate-job"
BUILD_NUMBER="$((RANDOM % 9000 + 1000))"  # random 4-digit number
FRAMEWORK="pytest"
BRANCH="${GIT_BRANCH:-$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'local')}"
GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
ENVIRONMENT="local"
ARTIFACTS_DIR=""
EXTRA_ARGS=()

# ── Parse args ────────────────────────────────────────────────────────────────
if [[ $# -eq 0 ]]; then
    echo "Usage: $0 <result-file> [--job NAME] [--build N] [--framework pytest|playwright|junit] [--environment ENV] [--branch BRANCH]"
    exit 1
fi

RESULT_FILE="$1"; shift

while [[ $# -gt 0 ]]; do
    case "$1" in
        --job)         JOB_NAME="$2"; shift 2;;
        --build)       BUILD_NUMBER="$2"; shift 2;;
        --framework)   FRAMEWORK="$2"; shift 2;;
        --branch)      BRANCH="$2"; shift 2;;
        --git-sha)     GIT_SHA="$2"; shift 2;;
        --environment) ENVIRONMENT="$2"; shift 2;;
        --artifacts-dir) ARTIFACTS_DIR="$2"; shift 2;;
        --dry-run)     EXTRA_ARGS+=("--dry-run"); shift;;
        --explain)     EXTRA_ARGS+=("--explain"); shift;;
        *)             echo "Unknown flag: $1"; exit 1;;
    esac
done

# ── Validate ──────────────────────────────────────────────────────────────────
if [[ ! -f "${RESULT_FILE}" ]]; then
    echo "Error: result file not found: ${RESULT_FILE}"
    exit 1
fi

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── Print summary ─────────────────────────────────────────────────────────────
echo ""
echo "simulate-build: uploading to Trapeze drop zone"
echo "  file:        ${RESULT_FILE}"
echo "  job:         ${JOB_NAME}"
echo "  build:       ${BUILD_NUMBER}"
echo "  framework:   ${FRAMEWORK}"
echo "  branch:      ${BRANCH}"
echo "  git-sha:     ${GIT_SHA}"
echo "  environment: ${ENVIRONMENT}"
echo "  started-at:  ${STARTED_AT}"
[[ -n "${ARTIFACTS_DIR}" ]] && echo "  artifacts:   ${ARTIFACTS_DIR}"
echo ""

# ── Run upload-to-drop-zone.ts ────────────────────────────────────────────────
cd "${REPO_ROOT}"

npx tsx ./scripts/upload-to-drop-zone.ts \
    --file        "${RESULT_FILE}" \
    --job         "${JOB_NAME}" \
    --build       "${BUILD_NUMBER}" \
    --framework   "${FRAMEWORK}" \
    --branch      "${BRANCH}" \
    --git-sha     "${GIT_SHA}" \
    --environment "${ENVIRONMENT}" \
    --started-at  "${STARTED_AT}" \
    --ci-provider "simulate" \
    ${ARTIFACTS_DIR:+--artifacts-dir "${ARTIFACTS_DIR}"} \
    ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}

echo ""
echo "Drop zone upload complete."
echo "Run the following to ingest into Postgres:"
echo "  npm run etl:ingest:from-gcs -- --explain"
