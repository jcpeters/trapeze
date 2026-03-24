#!/usr/bin/env bash
set -euo pipefail

# Trapeze E2E Demo
# ─────────────────────────────────────────────────────────────────────────────
# Demonstrates all Trapeze features in a single scripted run:
#   • Selenium (JUnit XML) ingest — 5 historical builds → flakiness signal
#   • Playwright JSON ingest
#   • Jira links: explicit via property tag, explicit via @tag
#   • TestRail links: via TR property tag, via Jira bridge, via title search
#   • Coverage snapshot
#   • Flake analysis
# ─────────────────────────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

JOB_SELENIUM="qa-evite-selenium-acceptance"
JOB_PW="qa-evite-playwright-acceptance"
BRANCH="main"
SHA="demo0001demo0001demo0001demo0001"
ENV="acceptance"
CI="simulate"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║          Trapeze E2E Demo                                    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── 1. Selenium (JUnit XML) — 5 historical builds ──────────────────────────
echo "── [1/6] Ingest Selenium — 5 historical builds ─────────────────"
echo "   Builds 3001–3005 alternating PASS/FAIL → flaky login test"
echo "   Login test tagged: jira=QAA-659, testrail.case=C27088"
echo "   RSVP test untagged → will be discovered via title search"
echo ""

npx tsx scripts/ingest-junit.ts junit_xml/demo/login-build-3001.xml --job $JOB_SELENIUM --build 3001 --branch $BRANCH --gitSha $SHA --environment $ENV --ci $CI
npx tsx scripts/ingest-junit.ts junit_xml/demo/login-build-3002.xml --job $JOB_SELENIUM --build 3002 --branch $BRANCH --gitSha $SHA --environment $ENV --ci $CI
npx tsx scripts/ingest-junit.ts junit_xml/demo/login-build-3003.xml --job $JOB_SELENIUM --build 3003 --branch $BRANCH --gitSha $SHA --environment $ENV --ci $CI
npx tsx scripts/ingest-junit.ts junit_xml/demo/login-build-3004.xml --job $JOB_SELENIUM --build 3004 --branch $BRANCH --gitSha $SHA --environment $ENV --ci $CI
npx tsx scripts/ingest-junit.ts junit_xml/demo/login-build-3005.xml --job $JOB_SELENIUM --build 3005 --branch $BRANCH --gitSha $SHA --environment $ENV --ci $CI

# ── 2. Playwright JSON — single build ──────────────────────────────────────
echo ""
echo "── [2/6] Ingest Playwright — build 3010 ────────────────────────"
echo "   Login spec tagged: @QAA-100 @C28961 @smoke"
echo "   RSVP spec tagged:  @QAA-660 @regression (no TR tag)"
echo ""

npx tsx scripts/ingest-playwright.ts --json-path junit_json/demo/playwright-build-3010.json --job $JOB_PW --build 3010 --branch $BRANCH --git-sha $SHA --environment $ENV --ci $CI

# ── 3. Infer TestRail ↔ TestCase links ────────────────────────────────────
echo ""
echo "── [3/6] Infer TestRail ↔ TestCase links ───────────────────────"
echo "   Discovers RSVP test → TR-19105 via title similarity"
echo ""

npx tsx scripts/infer-testrail-links.ts

# ── 4. Infer Jira ↔ TestRail links ────────────────────────────────────────
echo ""
echo "── [4/6] Infer Jira ↔ TestRail links ──────────────────────────"
echo "   Bridges QAA-100 → TR-28961 and QAA-660 → TR-19071 via DB join"
echo ""

npx tsx scripts/infer-jira-testrail-links.ts

# ── 5. Coverage snapshot ───────────────────────────────────────────────────
echo ""
echo "── [5/6] Coverage snapshot ─────────────────────────────────────"
echo ""

npx tsx scripts/snapshot-coverage.ts --force

# ── 6. Flake analysis ─────────────────────────────────────────────────────
echo ""
echo "── [6/6] Flake analysis ────────────────────────────────────────"
echo "   Login test: 2 failures / 5 runs → flakeScore ~0.4"
echo ""

npx tsx scripts/detect-flakes.ts --window-days 30

# ── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Demo complete! Useful queries:                              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  -- Flake decisions"
echo '  SELECT tc.title, fd.flake_score, fd.classification, fd.recommended_action'
echo '  FROM flake_decision fd JOIN test_case tc ON tc.id = fd.test_case_id'
echo '  ORDER BY fd.flake_score DESC LIMIT 10;'
echo ""
echo "  -- Coverage snapshot"
echo '  SELECT taken_at, total_issues, auto_executed_30d_pct, manual_executed_30d_pct'
echo '  FROM coverage_snapshot ORDER BY taken_at DESC LIMIT 1;'
echo ""
echo "  -- Jira → TestRail bridge links"
echo '  SELECT issue_key, tr_case_id, provenance, confidence, source'
echo '  FROM jira_testrail_link ORDER BY created_at DESC LIMIT 20;'
echo ""
echo "  -- TestCase → TestRail links (all 3 mechanisms)"
echo '  SELECT tc.title, atl.tr_case_id, atl.source, atl.confidence'
echo '  FROM automation_testrail_link atl JOIN test_case tc ON tc.id = atl.test_case_id'
echo '  ORDER BY tc.title;'
