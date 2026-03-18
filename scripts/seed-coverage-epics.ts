#!/usr/bin/env node
/**
 * seed-coverage-epics.ts
 *
 * Creates feature-area Jira epics as coverage anchors for automated
 * regression tests that have no individual Jira stories, then links
 * each TestCase to its feature-area epic via MANUAL/HIGH
 * jira_automation_link rows.
 *
 * Why epics as anchors?
 *   The Coverage Overview dashboard counts Jira issues as the denominator
 *   for coverage %.  Regression tests that target broad feature areas (e.g.
 *   Sign In, RSVP, Event Copy) don't map to individual stories, so coverage
 *   reads 0%.  Creating one Epic per feature area gives the dashboard a
 *   meaningful denominator and groups related tests visually.
 *
 * Idempotency:
 *   - If an epic with the same summary already exists in jira_issue the
 *     script skips the Jira API call and reuses the existing key.
 *   - jira_automation_link rows are upserted on (issueKey, testCaseId,
 *     provenance) — safe to re-run.
 *
 * Usage:
 *   npm run etl:seed:coverage-epics
 *   npm run etl:seed:coverage-epics -- --dry-run
 *   npm run etl:seed:coverage-epics -- --project EVT
 *   npm run etl:seed:coverage-epics -- --explain
 */

import "dotenv/config";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { z } from "zod";

import { prisma } from "./db/prisma.js";

// ── Environment ───────────────────────────────────────────────────────────────

const EnvSchema = z.object({
  DATABASE_URL:    z.string().min(1),
  JIRA_BASE_URL:   z.string().url().transform((u) => u.replace(/\/$/, "")),
  JIRA_EMAIL:      z.string().min(1),
  JIRA_API_TOKEN:  z.string().min(1),
});
type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    console.error(
      "Missing or invalid env vars:\n" +
        result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
    );
    process.exit(1);
  }
  return result.data;
}

// ── Feature-area definitions ──────────────────────────────────────────────────

/**
 * Each entry defines:
 *   summary     — Epic summary written to Jira (also used as uniqueness key)
 *   description — Plain-text description for the Epic body
 *   testTitles  — Exact TestCase.title strings that belong to this area
 */
const FEATURE_AREAS = [
  {
    summary: "Regression: Sign In & Authentication",
    description:
      "Coverage anchor for automated regression tests covering Sign In, SSO redirect, " +
      "valid/invalid credential flows, and session management.",
    testTitles: [
      "test_evite_sign_in.TestEviteSignIn",
      "should login with valid credentials",
      "should reject invalid password",
      "test SSO redirect",
    ],
  },
  {
    summary: "Regression: RSVP — Free Events",
    description:
      "Coverage anchor for RSVP happy paths on free events, including standard RSVP, " +
      "1-click-forward (1CF), concurrent-update edge cases, and capacity-lock behaviour.",
    testTitles: [
      "test_evite_rsvp_free.TestEviteRSVPFree",
      "test_evite_rsvp_free_1cf.TestEviteRSVPFree1CF",
      "should complete RSVP yes flow",
      "should skip RSVP when event is full",
      "test_rsvp_yes",
      "test RSVP yes",
      "concurrent update",
    ],
  },
  {
    summary: "Regression: RSVP — Premium Events",
    description:
      "Coverage anchor for RSVP happy paths on premium (paid) events.",
    testTitles: [
      "test_evite_rsvp_premium.TestEviteRSVPPremium",
    ],
  },
  {
    summary: "Regression: RSVP — Invitation Maker",
    description:
      "Coverage anchor for RSVP flows on Invitation Maker (v3) event types.",
    testTitles: [
      "test_evite_rsvp_invitation_maker_v3.TestEviteRSVPInvitationMakerV3",
    ],
  },
  {
    summary: "Regression: Event Copy — Free",
    description:
      "Coverage anchor for copying a past free event into a new draft.",
    testTitles: [
      "test_evite_copy_free_past_event.TestEviteCopyFreePastEvent",
    ],
  },
  {
    summary: "Regression: Event Copy — Premium",
    description:
      "Coverage anchor for copying a past premium event into a new draft.",
    testTitles: [
      "test_evite_copy_premium_past_event.TestEviteCopyPremiumPastEvent",
    ],
  },
  {
    summary: "Regression: eGift Cards",
    description:
      "Coverage anchor for eGift card creation and redemption flows.",
    testTitles: [
      "test_evite_egift_card_create_new.TestEviteEGiftCardCreateNew",
    ],
  },
  {
    summary: "Regression: Greeting Cards",
    description:
      "Coverage anchor for creating new greeting cards and creating from a past event.",
    testTitles: [
      "test_evite_greeting_card_create_new.TestEviteGreetingCardCreateNew",
      "test_evite_greeting_card_create_from_past_event.TestEviteGreetingCardCreateFromPastEvent",
    ],
  },
  {
    summary: "Regression: CMS Admin",
    description:
      "Coverage anchor for CMS admin redirect and admin-console access flows.",
    testTitles: [
      "test_evite_cms_admin_redirect.TestEviteCMSAdminRedirect",
    ],
  },
  {
    summary: "Regression: SUS / One-Day Event Create",
    description:
      "Coverage anchor for Single-Use-Sending (SUS) one-day event creation flows.",
    testTitles: [
      "test_evite_sus_one_day_create.TestEviteSUSOneDayCreate",
    ],
  },
  {
    summary: "Regression: Upsell & Gallery",
    description:
      "Coverage anchor for the upsell gallery page and premium design selection flows.",
    testTitles: [
      "test_evite_upsell_gallery_page.TestEviteUpsellGalleryPage",
    ],
  },
  {
    summary: "Regression: Checkout & Payments",
    description:
      "Coverage anchor for guest checkout, payment processing, and payment timeout handling.",
    testTitles: [
      "test guest checkout",
      "payment timeout",
    ],
  },
  {
    summary: "Regression: Invitations & Event View",
    description:
      "Coverage anchor for invitation send, event-view rendering, and combined " +
      "invite+RSVP flows.",
    testTitles: [
      "send button click",
      "test_view_invitation",
      "test view invitation QAA-100",
      "combined invite+rsvp flow",
    ],
  },
  {
    summary: "Regression: Event Signups & Locks",
    description:
      "Coverage anchor for event signup gating, capacity locks, and signup-lock " +
      "enforcement behaviour.",
    testTitles: [
      "test_event_signups_locked",
      "verify QAA-200 signup lock behaviour",
    ],
  },
] as const;

// ── Jira API helpers ──────────────────────────────────────────────────────────

function makeAuthHeader(env: Env): string {
  return "Basic " + Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64");
}

interface CreateIssueResponse {
  id: string;
  key: string;
  self: string;
}

async function createEpic(
  env: Env,
  projectKey: string,
  summary: string,
  description: string
): Promise<string> {
  const url = `${env.JIRA_BASE_URL}/rest/api/3/issue`;

  const body = {
    fields: {
      project: { key: projectKey },
      summary,
      issuetype: { name: "Epic" },
      // Atlassian Document Format description
      description: {
        version: 1,
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: description }],
          },
        ],
      },
      // Epic Name custom field — required by some classic Jira projects.
      // Harmless if the project doesn't use it (Jira ignores unknown fields
      // on next-gen projects; classic projects require it).
      customfield_10011: summary,
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: makeAuthHeader(env),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "(unreadable)");
    throw new Error(`Jira create-issue failed ${resp.status} ${resp.statusText}: ${text}`);
  }

  const data = (await resp.json()) as CreateIssueResponse;
  return data.key;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("seed-coverage-epics")
    .usage(
      "$0 [options]\n\n" +
      "Create feature-area Jira epics and link automated regression tests to them."
    )
    .option("project", {
      type:     "string",
      default:  "QAA",
      describe: "Jira project key to create epics in (e.g. QAA or EVT)",
    })
    .option("dry-run", {
      alias:   "n",
      type:    "boolean",
      default: false,
      describe: "Plan and report without creating any Jira issues or DB rows",
    })
    .option("explain", {
      type:    "boolean",
      default: false,
      describe: "Print verbose detail for every epic and link",
    })
    .help()
    .parse();

  const projectKey = argv["project"]  as string;
  const dryRun     = argv["dry-run"]  as boolean;
  const explain    = argv["explain"]  as boolean;
  const env        = loadEnv();

  console.log(`\nseeding coverage epics → project=${projectKey}${dryRun ? "  [dry-run]" : ""}\n`);

  // ── Load existing TestCase rows ─────────────────────────────────────────

  const testCases = await prisma.testCase.findMany({
    select: { id: true, title: true },
  });
  const testCaseByTitle = new Map(testCases.map((tc) => [tc.title, tc]));

  if (explain) {
    console.log(`Loaded ${testCases.length} TestCase row(s) from DB.\n`);
  }

  // ── Load existing jira_issue rows by summary for dedup ──────────────────

  const existingEpics = await prisma.jiraIssue.findMany({
    where: { issueType: "Epic" },
    select: { issueKey: true, summary: true },
  });
  const epicBySummary = new Map(existingEpics.map((e) => [e.summary ?? "", e.issueKey]));

  let epicsCreated  = 0;
  let epicsReused   = 0;
  let linksUpserted = 0;
  let testsUnmatched: string[] = [];

  // ── Process each feature area ────────────────────────────────────────────

  for (const area of FEATURE_AREAS) {
    let issueKey: string;

    // ── Step 1: create or reuse epic ──────────────────────────────────────

    if (epicBySummary.has(area.summary)) {
      issueKey = epicBySummary.get(area.summary)!;
      console.log(`  reuse  ${issueKey}  "${area.summary}"`);
      epicsReused++;
    } else if (dryRun) {
      issueKey = `${projectKey}-DRY`;
      console.log(`  [dry]  (would create)  "${area.summary}"`);
      epicsCreated++;
    } else {
      issueKey = await createEpic(env, projectKey, area.summary, area.description);
      console.log(`  create ${issueKey}  "${area.summary}"`);
      epicsCreated++;

      // ── Step 2: upsert epic into jira_issue so sync-jira picks it up ──
      const now = new Date();
      await prisma.jiraIssue.upsert({
        where:  { issueKey },
        create: {
          issueKey,
          issueType:  "Epic",
          summary:    area.summary,
          status:     "To Do",
          projectKey,
          priority:   null,
          labels:     [],
          createdAt:  now,
          updatedAt:  now,
          resolvedAt: null,
          raw:        { seededBy: "seed-coverage-epics.ts" },
        },
        update: {
          summary:   area.summary,
          updatedAt: now,
        },
      });
    }

    // ── Step 3: create MANUAL/HIGH jira_automation_link rows ─────────────

    for (const title of area.testTitles) {
      const tc = testCaseByTitle.get(title);

      if (!tc) {
        testsUnmatched.push(title);
        if (explain) {
          console.log(`    ✗  no TestCase row for: "${title}"`);
        }
        continue;
      }

      if (explain) {
        const tag = dryRun ? "[dry] " : "";
        console.log(`    ${tag}→ ${tc.id.slice(0, 8)}  "${title}"`);
      }

      if (!dryRun) {
        await prisma.jiraAutomationLink.upsert({
          where: {
            issueKey_testCaseId_provenance: {
              issueKey:   issueKey,
              testCaseId: tc.id,
              provenance: "MANUAL",
            },
          },
          create: {
            issueKey,
            testCaseId: tc.id,
            provenance: "MANUAL",
            confidence: "HIGH",
            evidence:   `feature-area coverage anchor: ${area.summary}`,
            source:     "seed-coverage-epics",
          },
          update: {
            confidence: "HIGH",
            evidence:   `feature-area coverage anchor: ${area.summary}`,
            source:     "seed-coverage-epics",
          },
        });
      }

      linksUpserted++;
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  const dryTag = dryRun ? " [dry-run, no writes]" : "";
  console.log(
    `\nDone:  epicsCreated=${epicsCreated}  epicsReused=${epicsReused}` +
    `  linksUpserted=${linksUpserted}${dryTag}`
  );

  if (testsUnmatched.length > 0) {
    console.warn(
      `\nWarning: ${testsUnmatched.length} test title(s) not found in TestCase table:` +
        testsUnmatched.map((t) => `\n  "${t}"`).join("")
    );
    console.warn("Run `npm run etl:ingest:junit` or `etl:ingest:playwright` first.");
  }

  if (!dryRun && linksUpserted > 0) {
    console.log(
      "\nNext steps:" +
      "\n  1. npm run etl:sync:jira -- --full-sync   # pull updated epics into jira_issue" +
      "\n  2. npm run etl:infer:jira                 # re-run Jira link inference" +
      "\n  3. npm run etl:snapshot:coverage -- --force  # refresh coverage KPIs"
    );
  }
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
