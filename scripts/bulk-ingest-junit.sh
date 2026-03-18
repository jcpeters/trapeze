#!/usr/bin/env bash
# Bulk ingest all JUnit XML files from junit_xml/
# File naming convention: {buildNumber}.xml
# Job confirmed from stack traces: qa-evite-test-tests-acceptance

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
XML_DIR="${REPO_DIR}/junit_xml"
JOB_NAME="qa-evite-test-tests-acceptance"
ENVIRONMENT="acceptance"
FRAMEWORK="pytest"

# Set your Jenkins base URL here — enables direct links from Metabase back to builds
JENKINS_URL="https://jenkins.evite.com"   # update if different

DRY_RUN="${1:-}"   # pass --dry-run as first arg to validate without writing

success=0
failed=0
skipped=0

for xml_file in "$XML_DIR"/*.xml; do
  filename="$(basename "$xml_file")"
  build_number="${filename%.xml}"

  # Guard: filename must be a plain integer
  if ! [[ "$build_number" =~ ^[0-9]+$ ]]; then
    echo "SKIP  $filename (filename is not a build number)"
    ((skipped++)) || true
    continue
  fi

  # Extract timestamp from the XML <testsuite timestamp="..."> attribute
  started_at="$(grep -o 'timestamp="[^"]*"' "$xml_file" | head -1 | sed 's/timestamp="//;s/"//')"

  build_url="${JENKINS_URL}/job/${JOB_NAME}/${build_number}/"

  echo "------------------------------------------------------------"
  echo "Ingesting build ${build_number}  (${filename})"
  echo "  startedAt : ${started_at:-not found}"
  echo "  buildUrl  : ${build_url}"

  ingest_args=(
    "$xml_file"
    --job "$JOB_NAME"
    --build "$build_number"
    --framework "$FRAMEWORK"
    --environment "$ENVIRONMENT"
    --build-url "$build_url"
  )

  # Only add --startedAt if we extracted a value from the XML
  if [[ -n "$started_at" ]]; then
    ingest_args+=(--startedAt "$started_at")
  fi

  if [[ "$DRY_RUN" == "--dry-run" ]]; then
    ingest_args+=(--dryRun)
  fi

  if npm run etl:ingest:junit -- "${ingest_args[@]}"; then
    echo "  ✓ OK"
    ((success++)) || true
  else
    echo "  ✗ FAILED — continuing with remaining files"
    ((failed++)) || true
  fi
done

echo ""
echo "============================================================"
echo "Bulk ingest complete"
echo "  Success : $success"
echo "  Failed  : $failed"
echo "  Skipped : $skipped"
echo "  Total   : $((success + failed + skipped))"

if [[ $failed -gt 0 ]]; then
  exit 1
fi

