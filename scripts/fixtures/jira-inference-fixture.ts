#!/usr/bin/env node
/**
 * Temporary fixture: seeds jira_issue + test_case rows that exercise every
 * field/position the name-inference scan covers.
 *
 * Run once:
 *   tsx ./scripts/fixtures/jira-inference-fixture.ts
 *
 * Then run the inference scan:
 *   npm run etl:infer:jira -- --dry-run --explain
 *   npm run etl:infer:jira -- --explain
 */

import "dotenv/config";
import { prisma } from "../db/prisma";

async function main() {
  console.log("Seeding jira-inference fixture data…");

  // ── 1. Jira issues ──────────────────────────────────────────────────────
  //   A mix of projects so we can confirm multi-project matching works.
  const issues = [
    { issueKey: "QAA-100", issueType: "Story",  summary: "View invitation page" },
    { issueKey: "QAA-101", issueType: "Story",  summary: "RSVP yes flow" },
    { issueKey: "QAA-200", issueType: "Bug",    summary: "Signup button disabled after lock" },
    { issueKey: "PROJ-42", issueType: "Task",   summary: "Login with Google SSO" },
    { issueKey: "PROJ-99", issueType: "Story",  summary: "Guest checkout flow" },
  ];

  for (const iss of issues) {
    await prisma.jiraIssue.upsert({
      where:  { issueKey: iss.issueKey },
      update: { summary: iss.summary },
      create: {
        issueKey:   iss.issueKey,
        issueType:  iss.issueType,
        summary:    iss.summary,
        projectKey: iss.issueKey.split("-")[0],
      },
    });
  }
  console.log(`  ✓ ${issues.length} jira_issue rows`);

  // ── 2. Test cases whose names embed Jira keys in different positions ───
  //
  //   identityKey format: "classname::testname"  (mimics pytest JUnit output)
  //
  //   Scenarios:
  //   a) Key in test-function name suffix        QAA-100 in identityKey
  //   b) Key at start of function name           PROJ-42 in identityKey
  //   c) Key in classname part                   QAA-101 in identityKey
  //   d) Key only in title (not identityKey)     QAA-200 in title
  //   e) Key only in suiteName                   PROJ-99 in suiteName
  //   f) Two keys in same identityKey            QAA-100 + QAA-101
  //   g) Key that does NOT exist in jira_issue   NOPE-1 → should be skipped
  //   h) No keys at all                          → no links written

  const testCases = [
    {
      identityKey: "tests.invite.TestView::test_view_invitation_QAA-100",
      title:       "test view invitation QAA-100",
      suiteName:   "invite-suite",
      // Expected: link to QAA-100  (identityKey + title both match; deduped)
    },
    {
      identityKey: "tests.auth.PROJ-42_login_google::test_sso_redirect",
      title:       "test SSO redirect",
      suiteName:   "auth-suite",
      // Expected: link to PROJ-42  (identityKey classname part)
    },
    {
      identityKey: "tests.rsvp.QAA-101_RsvpFlow::test_rsvp_yes",
      title:       "test RSVP yes",
      suiteName:   "rsvp-suite",
      // Expected: link to QAA-101
    },
    {
      identityKey: "tests.signups::test_event_signups_locked",
      title:       "verify QAA-200 signup lock behaviour",
      suiteName:   "signups-suite",
      // Expected: link to QAA-200  (title only)
    },
    {
      identityKey: "tests.checkout::test_guest_flow",
      title:       "test guest checkout",
      suiteName:   "PROJ-99 checkout suite",
      // Expected: link to PROJ-99  (suiteName only)
    },
    {
      identityKey: "tests.combined::test_invite_QAA-100_and_rsvp_QAA-101",
      title:       "combined invite+rsvp flow",
      suiteName:   "combined-suite",
      // Expected: links to BOTH QAA-100 and QAA-101
    },
    {
      identityKey: "tests.unknown::test_references_NOPE-1_key",
      title:       "test with unknown Jira ref",
      suiteName:   "misc-suite",
      // Expected: NOPE-1 NOT in jira_issue → skipped
    },
    {
      identityKey: "tests.nokeys::test_plain_assertion",
      title:       "plain assertion test",
      suiteName:   "misc-suite",
      // Expected: no links
    },
  ];

  for (const tc of testCases) {
    await prisma.testCase.upsert({
      where:  { identityKey: tc.identityKey },
      update: { title: tc.title, suiteName: tc.suiteName },
      create: { identityKey: tc.identityKey, title: tc.title, suiteName: tc.suiteName },
    });
  }
  console.log(`  ✓ ${testCases.length} test_case rows`);
  console.log("\nFixture ready. Now run:");
  console.log("  npm run etl:infer:jira -- --dry-run --explain");
  console.log("  npm run etl:infer:jira -- --explain");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
