#!/usr/bin/env node
/**
 * sync-demo-fixture.ts
 *
 * Seeds realistic demo data for testing the Jira ↔ TestRail sync and inference
 * pipeline end-to-end without needing live API access.
 *
 * What it creates
 * ───────────────
 * • 12 JiraIssue rows   — mix of Epics, Stories, and Bugs across QAA + EVT projects
 * • 18 TestRailCase rows — realistic automation test cases with refs pointing to Jira
 * • 24 TestRailResult rows — mix of Pass/Fail/Blocked statuses across two runs
 *
 * After seeding, run the inference scripts to wire up links:
 *
 *   npm run etl:infer:jira           -- --explain
 *   npm run etl:infer:testrail       -- --explain
 *   npm run etl:infer:jira-testrail  -- --explain
 *
 * Then check coverage:
 *   npm run etl:snapshot:coverage
 *
 * Teardown:
 *   tsx ./scripts/fixtures/sync-demo-fixture.ts --teardown
 *
 * Re-running is safe — all upserts use unique keys.
 */

import "dotenv/config";
import { prisma } from "../db/prisma";

// ── Constants ──────────────────────────────────────────────────────────────────

// Two fake TestRail run IDs so results span multiple runs (tests coverage of
// the testrail_result.tr_run_id grouping in Metabase queries)
const RUN_A = 5001n; // "Sprint 42 Regression"
const RUN_B = 5002n; // "Sprint 43 Regression"

// Status IDs from TestRail: 1=Passed 2=Blocked 3=Untested 4=Retest 5=Failed
const PASS = 1;
const BLOCKED = 2;
const FAILED = 5;

// ── Jira Issues ────────────────────────────────────────────────────────────────

const jiraIssues = [
  // Epics — top-level feature areas
  {
    issueKey: "QAA-500",
    issueType: "Epic",
    summary: "Invitation Flow — Automated Regression Coverage",
    status: "In Progress",
    projectKey: "QAA",
    priority: "High",
    labels: ["automation", "regression"],
  },
  {
    issueKey: "QAA-501",
    issueType: "Epic",
    summary: "RSVP Flow — Automated Regression Coverage",
    status: "In Progress",
    projectKey: "QAA",
    priority: "High",
    labels: ["automation", "regression"],
  },
  {
    issueKey: "QAA-502",
    issueType: "Epic",
    summary: "Authentication & Login — Automated Regression Coverage",
    status: "To Do",
    projectKey: "QAA",
    priority: "Medium",
    labels: ["automation"],
  },

  // Stories under QAA-500 (Invitation Epic)
  {
    issueKey: "QAA-510",
    issueType: "Story",
    summary: "View invitation page renders correctly for all event types",
    status: "Done",
    parentKey: "QAA-500",
    projectKey: "QAA",
    priority: "High",
    labels: ["automation", "smoke"],
  },
  {
    issueKey: "QAA-511",
    issueType: "Story",
    summary: "Invitation countdown timer displays correct time remaining",
    status: "In Progress",
    parentKey: "QAA-500",
    projectKey: "QAA",
    priority: "Medium",
    labels: ["automation"],
  },
  {
    issueKey: "QAA-512",
    issueType: "Bug",
    summary: "Invitation page flickers on mobile Safari when scrolling",
    status: "Open",
    parentKey: "QAA-500",
    projectKey: "QAA",
    priority: "High",
    labels: ["bug", "mobile", "safari"],
  },

  // Stories under QAA-501 (RSVP Epic)
  {
    issueKey: "QAA-520",
    issueType: "Story",
    summary: "Guest can RSVP Yes and see confirmation screen",
    status: "Done",
    parentKey: "QAA-501",
    projectKey: "QAA",
    priority: "High",
    labels: ["automation", "smoke"],
  },
  {
    issueKey: "QAA-521",
    issueType: "Story",
    summary: "Guest can update RSVP from Yes to No",
    status: "In Progress",
    parentKey: "QAA-501",
    projectKey: "QAA",
    priority: "Medium",
    labels: ["automation"],
  },
  {
    issueKey: "QAA-522",
    issueType: "Bug",
    summary:
      "RSVP form does not validate plus-one count when max_guests is set",
    status: "Open",
    parentKey: "QAA-501",
    projectKey: "QAA",
    priority: "Critical",
    labels: ["bug", "regression"],
  },

  // Stories under QAA-502 (Auth Epic)
  {
    issueKey: "QAA-530",
    issueType: "Story",
    summary: "User can log in with email and password",
    status: "Done",
    parentKey: "QAA-502",
    projectKey: "QAA",
    priority: "High",
    labels: ["automation", "smoke"],
  },
  {
    issueKey: "QAA-531",
    issueType: "Story",
    summary: "User can log in with Google SSO",
    status: "Done",
    parentKey: "QAA-502",
    projectKey: "QAA",
    priority: "High",
    labels: ["automation"],
  },

  // Cross-project EVT issue (tests the multi-project inference path)
  {
    issueKey: "EVT-200",
    issueType: "Story",
    summary: "Homepage loads under 2s on mobile LTE",
    status: "In Progress",
    projectKey: "EVT",
    priority: "Medium",
    labels: ["performance", "mobile"],
  },
];

// ── TestRail Cases ─────────────────────────────────────────────────────────────
//
// refs field mirrors TestRail's "References" custom field where testers paste
// Jira keys. The sync script (`sync-testrail.ts`) parses this field and creates
// JiraTestRailLink rows with provenance=EXPLICIT / confidence=HIGH.

const trCases = [
  // ── Invitation suite (section "Invitation / View") ────────────────────────
  {
    trCaseId: 80001n,
    title: "Verify invitation page loads for Birthday event type",
    sectionPath: "Invitation / View",
    suiteId: 200n,
    priority: "High",
    refs: "QAA-510",
  },
  {
    trCaseId: 80002n,
    title: "Verify invitation page loads for Wedding event type",
    sectionPath: "Invitation / View",
    suiteId: 200n,
    priority: "High",
    refs: "QAA-510",
  },
  {
    trCaseId: 80003n,
    title: "Verify invitation page loads for Holiday event type",
    sectionPath: "Invitation / View",
    suiteId: 200n,
    priority: "Medium",
    refs: "QAA-510",
  },
  {
    trCaseId: 80004n,
    title: "Verify countdown timer shows correct days remaining",
    sectionPath: "Invitation / Countdown",
    suiteId: 200n,
    priority: "Medium",
    refs: "QAA-511",
  },
  {
    trCaseId: 80005n,
    title: "Verify countdown timer reaches zero on event date",
    sectionPath: "Invitation / Countdown",
    suiteId: 200n,
    priority: "Low",
    refs: "QAA-511",
  },
  {
    trCaseId: 80006n,
    title: "Verify invitation page does not flicker on mobile scroll (Safari)",
    sectionPath: "Invitation / Mobile",
    suiteId: 200n,
    priority: "High",
    refs: "QAA-512", // Bug — regression test
  },

  // ── RSVP suite (section "RSVP / Guest Actions") ───────────────────────────
  {
    trCaseId: 80010n,
    title: "Guest RSVPs Yes — confirm confirmation screen shown",
    sectionPath: "RSVP / Guest Actions",
    suiteId: 201n,
    priority: "Critical",
    refs: "QAA-520",
  },
  {
    trCaseId: 80011n,
    title: "Guest RSVPs Yes — confirm guest appears in event list",
    sectionPath: "RSVP / Guest Actions",
    suiteId: 201n,
    priority: "High",
    refs: "QAA-520",
  },
  {
    trCaseId: 80012n,
    title: "Guest updates RSVP from Yes to No",
    sectionPath: "RSVP / Guest Actions",
    suiteId: 201n,
    priority: "High",
    refs: "QAA-521",
  },
  {
    trCaseId: 80013n,
    title: "RSVP form validates plus-one count when max_guests reached",
    sectionPath: "RSVP / Validation",
    suiteId: 201n,
    priority: "Critical",
    refs: "QAA-522", // Bug regression
  },
  {
    trCaseId: 80014n,
    title: "RSVP form rejects plus-one count exceeding max_guests",
    sectionPath: "RSVP / Validation",
    suiteId: 201n,
    priority: "High",
    refs: "QAA-522",
  },

  // ── Auth suite (section "Auth / Login") ───────────────────────────────────
  {
    trCaseId: 80020n,
    title: "Login with valid email and password",
    sectionPath: "Auth / Login",
    suiteId: 202n,
    priority: "Critical",
    refs: "QAA-530",
  },
  {
    trCaseId: 80021n,
    title: "Login fails with invalid password — error message shown",
    sectionPath: "Auth / Login",
    suiteId: 202n,
    priority: "High",
    refs: "QAA-530",
  },
  {
    trCaseId: 80022n,
    title: "Login with Google SSO — redirected to home after auth",
    sectionPath: "Auth / SSO",
    suiteId: 202n,
    priority: "High",
    refs: "QAA-531",
  },
  {
    trCaseId: 80023n,
    title: "Login with Google SSO — new account created on first sign-in",
    sectionPath: "Auth / SSO",
    suiteId: 202n,
    priority: "Medium",
    refs: "QAA-531",
  },

  // ── Performance suite (cross-project EVT ref) ─────────────────────────────
  {
    trCaseId: 80030n,
    title: "Homepage LCP under 2s on simulated mobile LTE",
    sectionPath: "Performance / Homepage",
    suiteId: 203n,
    priority: "High",
    refs: "EVT-200",
  },

  // ── Orphan case — no refs (tests inference-only path) ─────────────────────
  {
    trCaseId: 80099n,
    title: "Verify footer links are accessible via keyboard navigation",
    sectionPath: "Accessibility / Footer",
    suiteId: 204n,
    priority: "Low",
    refs: null, // No Jira ref — will only be linked via text inference
  },

  // ── Multi-ref case — two Jira keys in refs ────────────────────────────────
  {
    trCaseId: 80100n,
    title: "End-to-end: view invitation and RSVP yes in one session",
    sectionPath: "E2E / Happy Path",
    suiteId: 205n,
    priority: "Critical",
    refs: "QAA-510, QAA-520", // Tests multi-link parsing
  },
];

// ── TestRail Results ───────────────────────────────────────────────────────────
//
// Two "runs" of results:
//   RUN_A (Sprint 42): mostly passing, some failures for known bugs
//   RUN_B (Sprint 43): re-run after fixes — failures resolved or still open
//
// statusId: 1=Pass 2=Blocked 5=Fail

const trResults: Array<{
  trResultId: bigint;
  trRunId: bigint;
  trCaseId: bigint;
  statusId: number;
  testedAt: Date;
}> = [
  // ── Run A (Sprint 42) results ──────────────────────────────────────────────
  {
    trResultId: 90001n,
    trRunId: RUN_A,
    trCaseId: 80001n,
    statusId: PASS,
    testedAt: new Date("2026-02-01T09:00:00Z"),
  },
  {
    trResultId: 90002n,
    trRunId: RUN_A,
    trCaseId: 80002n,
    statusId: PASS,
    testedAt: new Date("2026-02-01T09:05:00Z"),
  },
  {
    trResultId: 90003n,
    trRunId: RUN_A,
    trCaseId: 80003n,
    statusId: PASS,
    testedAt: new Date("2026-02-01T09:10:00Z"),
  },
  {
    trResultId: 90004n,
    trRunId: RUN_A,
    trCaseId: 80004n,
    statusId: PASS,
    testedAt: new Date("2026-02-01T09:15:00Z"),
  },
  {
    trResultId: 90005n,
    trRunId: RUN_A,
    trCaseId: 80005n,
    statusId: PASS,
    testedAt: new Date("2026-02-01T09:20:00Z"),
  },
  {
    trResultId: 90006n,
    trRunId: RUN_A,
    trCaseId: 80006n,
    statusId: FAILED,
    testedAt: new Date("2026-02-01T09:25:00Z"),
  }, // QAA-512 bug
  {
    trResultId: 90010n,
    trRunId: RUN_A,
    trCaseId: 80010n,
    statusId: PASS,
    testedAt: new Date("2026-02-01T10:00:00Z"),
  },
  {
    trResultId: 90011n,
    trRunId: RUN_A,
    trCaseId: 80011n,
    statusId: PASS,
    testedAt: new Date("2026-02-01T10:05:00Z"),
  },
  {
    trResultId: 90012n,
    trRunId: RUN_A,
    trCaseId: 80012n,
    statusId: PASS,
    testedAt: new Date("2026-02-01T10:10:00Z"),
  },
  {
    trResultId: 90013n,
    trRunId: RUN_A,
    trCaseId: 80013n,
    statusId: FAILED,
    testedAt: new Date("2026-02-01T10:15:00Z"),
  }, // QAA-522 bug
  {
    trResultId: 90014n,
    trRunId: RUN_A,
    trCaseId: 80014n,
    statusId: FAILED,
    testedAt: new Date("2026-02-01T10:20:00Z"),
  }, // QAA-522 bug
  {
    trResultId: 90020n,
    trRunId: RUN_A,
    trCaseId: 80020n,
    statusId: PASS,
    testedAt: new Date("2026-02-01T11:00:00Z"),
  },
  {
    trResultId: 90021n,
    trRunId: RUN_A,
    trCaseId: 80021n,
    statusId: PASS,
    testedAt: new Date("2026-02-01T11:05:00Z"),
  },
  {
    trResultId: 90022n,
    trRunId: RUN_A,
    trCaseId: 80022n,
    statusId: PASS,
    testedAt: new Date("2026-02-01T11:10:00Z"),
  },
  {
    trResultId: 90023n,
    trRunId: RUN_A,
    trCaseId: 80023n,
    statusId: BLOCKED,
    testedAt: new Date("2026-02-01T11:15:00Z"),
  }, // env issue in sprint 42
  {
    trResultId: 90030n,
    trRunId: RUN_A,
    trCaseId: 80030n,
    statusId: FAILED,
    testedAt: new Date("2026-02-01T12:00:00Z"),
  }, // perf miss
  {
    trResultId: 90100n,
    trRunId: RUN_A,
    trCaseId: 80100n,
    statusId: PASS,
    testedAt: new Date("2026-02-01T13:00:00Z"),
  },

  // ── Run B (Sprint 43) results ──────────────────────────────────────────────
  // Bugs from QAA-512 and QAA-522 still open; SSO blocker resolved; perf improving
  {
    trResultId: 91006n,
    trRunId: RUN_B,
    trCaseId: 80006n,
    statusId: FAILED,
    testedAt: new Date("2026-02-15T09:25:00Z"),
  }, // QAA-512 still open
  {
    trResultId: 91013n,
    trRunId: RUN_B,
    trCaseId: 80013n,
    statusId: FAILED,
    testedAt: new Date("2026-02-15T10:15:00Z"),
  }, // QAA-522 still open
  {
    trResultId: 91014n,
    trRunId: RUN_B,
    trCaseId: 80014n,
    statusId: PASS,
    testedAt: new Date("2026-02-15T10:20:00Z"),
  }, // partial fix
  {
    trResultId: 91023n,
    trRunId: RUN_B,
    trCaseId: 80023n,
    statusId: PASS,
    testedAt: new Date("2026-02-15T11:15:00Z"),
  }, // SSO resolved
  {
    trResultId: 91030n,
    trRunId: RUN_B,
    trCaseId: 80030n,
    statusId: PASS,
    testedAt: new Date("2026-02-15T12:00:00Z"),
  }, // perf fixed
  {
    trResultId: 91100n,
    trRunId: RUN_B,
    trCaseId: 80100n,
    statusId: PASS,
    testedAt: new Date("2026-02-15T13:00:00Z"),
  },
  {
    trResultId: 91099n,
    trRunId: RUN_B,
    trCaseId: 80099n,
    statusId: PASS,
    testedAt: new Date("2026-02-15T14:00:00Z"),
  }, // orphan case
];

// ── Main ───────────────────────────────────────────────────────────────────────

async function seed() {
  console.log("Seeding sync-demo fixture data…\n");

  // 1. Jira issues
  let jiraCount = 0;
  for (const iss of jiraIssues) {
    await prisma.jiraIssue.upsert({
      where: { issueKey: iss.issueKey },
      update: {
        summary: iss.summary,
        issueType: iss.issueType,
        status: iss.status,
        parentKey: iss.parentKey ?? null,
        priority: iss.priority,
        labels: iss.labels,
        updatedAt: new Date(),
      },
      create: {
        issueKey: iss.issueKey,
        issueType: iss.issueType,
        summary: iss.summary,
        status: iss.status,
        parentKey: iss.parentKey ?? null,
        projectKey: iss.projectKey,
        priority: iss.priority,
        labels: iss.labels,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date(),
      },
    });
    jiraCount++;
  }
  console.log(`  ✓ ${jiraCount} jira_issue rows (QAA + EVT projects)`);

  // 2. TestRail cases
  let trCaseCount = 0;
  for (const tc of trCases) {
    await prisma.testRailCase.upsert({
      where: { trCaseId: tc.trCaseId },
      update: {
        title: tc.title,
        sectionPath: tc.sectionPath,
        suiteId: tc.suiteId,
        priority: tc.priority,
        refs: tc.refs,
      },
      create: {
        trCaseId: tc.trCaseId,
        title: tc.title,
        sectionPath: tc.sectionPath,
        suiteId: tc.suiteId,
        priority: tc.priority,
        refs: tc.refs,
      },
    });
    trCaseCount++;
  }
  console.log(`  ✓ ${trCaseCount} testrail_case rows (5 suites)`);

  // 3. TestRail results
  let trResultCount = 0;
  for (const r of trResults) {
    await prisma.testRailResult.upsert({
      where: { trResultId: r.trResultId },
      update: { statusId: r.statusId, testedAt: r.testedAt },
      create: {
        trResultId: r.trResultId,
        trRunId: r.trRunId,
        trCaseId: r.trCaseId,
        statusId: r.statusId,
        testedAt: r.testedAt,
      },
    });
    trResultCount++;
  }
  const passCount = trResults.filter((r) => r.statusId === PASS).length;
  const failCount = trResults.filter((r) => r.statusId === FAILED).length;
  const blockedCount = trResults.filter((r) => r.statusId === BLOCKED).length;
  console.log(
    `  ✓ ${trResultCount} testrail_result rows` +
      ` (${passCount} pass / ${failCount} fail / ${blockedCount} blocked` +
      ` across runs ${RUN_A} and ${RUN_B})`,
  );

  // 4. EXPLICIT Jira ↔ TestRail links from refs field
  //    Simulates what sync-testrail.ts would do when it processes the real API.
  //    Parses each case's refs string and creates EXPLICIT/HIGH links for any
  //    Jira key already present in jira_issue.
  const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;
  const knownIssueKeys = new Set(jiraIssues.map((i) => i.issueKey));
  let explicitLinkCount = 0;

  for (const tc of trCases) {
    if (!tc.refs) continue;
    JIRA_KEY_RE.lastIndex = 0;
    const keys: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = JIRA_KEY_RE.exec(tc.refs)) !== null) keys.push(m[1]);
    const uniqueKeys = [...new Set(keys)].filter((k) => knownIssueKeys.has(k));

    for (const issueKey of uniqueKeys) {
      await prisma.jiraTestRailLink.upsert({
        where: {
          issueKey_trCaseId_provenance: {
            issueKey,
            trCaseId: tc.trCaseId,
            provenance: "EXPLICIT",
          },
        },
        create: {
          issueKey,
          trCaseId: tc.trCaseId,
          provenance: "EXPLICIT",
          confidence: "HIGH",
          evidence: `refs field: "${tc.refs.slice(0, 120)}"`,
          source: "testrail-refs",
        },
        update: {
          confidence: "HIGH",
          evidence: `refs field: "${tc.refs.slice(0, 120)}"`,
        },
      });
      explicitLinkCount++;
    }
  }
  console.log(
    `  ✓ ${explicitLinkCount} jira_testrail_link rows (EXPLICIT/HIGH from refs)`,
  );

  console.log(`
Fixture ready. Next steps:

  1. Run inference to add INFERRED links (similarity + bridge strategies):
       npm run etl:infer:jira-testrail -- --explain

  2. Link TestRail cases to automated TestCase rows (if selenium/playwright runs exist):
       npm run etl:infer:testrail -- --explain

  3. Link Jira issues to automated TestCase rows via key scanning:
       npm run etl:infer:jira -- --explain

  4. Snapshot coverage KPIs:
       npm run etl:snapshot:coverage

  5. Verify in Metabase → http://localhost:3000

Teardown (removes all rows seeded by this fixture):
  tsx ./scripts/fixtures/sync-demo-fixture.ts --teardown
`);
}

async function teardown() {
  console.log("Tearing down sync-demo fixture data…\n");

  const resultIds = trResults.map((r) => r.trResultId);
  const caseIds = trCases.map((tc) => tc.trCaseId);
  const issueKeys = jiraIssues.map((i) => i.issueKey);

  // Delete results first (FK dependency)
  const r = await prisma.testRailResult.deleteMany({
    where: { trResultId: { in: resultIds } },
  });
  console.log(`  ✓ Deleted ${r.count} testrail_result rows`);

  // Delete jira_testrail_link rows referencing our cases
  const l = await prisma.jiraTestRailLink.deleteMany({
    where: {
      OR: [{ issueKey: { in: issueKeys } }, { trCaseId: { in: caseIds } }],
    },
  });
  console.log(`  ✓ Deleted ${l.count} jira_testrail_link rows`);

  // Delete TR cases
  const tc = await prisma.testRailCase.deleteMany({
    where: { trCaseId: { in: caseIds } },
  });
  console.log(`  ✓ Deleted ${tc.count} testrail_case rows`);

  // Delete jira_automation_link rows referencing our issues
  const la = await prisma.jiraAutomationLink.deleteMany({
    where: { issueKey: { in: issueKeys } },
  });
  console.log(`  ✓ Deleted ${la.count} jira_automation_link rows`);

  // Delete Jira issues
  const ji = await prisma.jiraIssue.deleteMany({
    where: { issueKey: { in: issueKeys } },
  });
  console.log(`  ✓ Deleted ${ji.count} jira_issue rows`);

  console.log("\nTeardown complete.");
}

const isTeardown = process.argv.includes("--teardown");

(isTeardown ? teardown() : seed())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
