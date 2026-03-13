#!/usr/bin/env node
/**
 * Seed TestExecution + TestAttempt rows that exercise every flake-detection
 * path in detect-flakes.ts.
 *
 * Scenarios
 * ─────────
 *  A) login::happy_path             — 10 PASSED  → score=0.0  (healthy, below threshold)
 *  B) checkout::payment_timeout     — 8F 2P      → score≈0.4  classification=INFRA
 *  C) invite::send_button_click     — 3F 4P 3K   → score≈0.7  classification=TEST_CODE
 *  D) rsvp::concurrent_update       — 5P 5 FLAKY → score≈0.5  classification=PRODUCT_BUG
 *  E) search::filter_panel          — 3 runs only → skipped (below min-runs=5)
 */

import "dotenv/config";
import crypto from "node:crypto";
import { prisma } from "../db/prisma";

const JOB   = "qa-e2e/flake-fixture-job";
const SHA   = "fixture000";

function hash(msg: string) {
  return crypto.createHash("sha256").update(msg).digest("hex").slice(0, 16);
}

// Build+CiRun for a single build number, returning ciRun.id
async function makeRun(buildNo: number, startedAt: Date, status: string) {
  const build = await prisma.build.upsert({
    where: { build_unique_ci_job_number: { ciProvider: "jenkins", jobName: JOB, buildNumber: buildNo } },
    update: {},
    create: { ciProvider: "jenkins", jobName: JOB, buildNumber: buildNo, gitSha: SHA, branch: "main", startedAt, finishedAt: new Date(startedAt.getTime() + 60_000) },
  });
  return prisma.ciRun.create({
    data: { buildId: build.id, jobName: JOB, buildNumber: buildNo, startedAt, finishedAt: new Date(startedAt.getTime() + 60_000), status: status as any },
  });
}

// Create one TestExecution + its attempts
async function makeExec(
  runId: string,
  testId: string,
  project: string,
  execStatus: string,
  attempts: Array<{ status: string; errorMsg?: string; retry: number }>,
) {
  const failureMsg = attempts.find(a => a.status !== "passed")?.errorMsg ?? null;
  const exec = await prisma.testExecution.create({
    data: {
      runId, testId,
      filePath:  testId.split("::")[0],
      titlePath: testId.split("::")[1]?.split(" > ") ?? [testId],
      project,
      status: execStatus as any,
      durationMs: 1000 + Math.floor(Math.random() * 2000),
      failureMsg: failureMsg?.slice(0, 500) ?? null,
    },
  });
  for (const a of attempts) {
    const start = new Date();
    await prisma.testAttempt.create({
      data: {
        executionId: exec.id,
        attemptNo:   a.retry,
        status:      (a.status === "passed" ? "PASSED" : a.status === "skipped" ? "SKIPPED" : "FAILED") as any,
        durationMs:  1000,
        errorHash:   a.errorMsg ? hash(a.errorMsg) : null,
        startedAt:   start,
        finishedAt:  new Date(start.getTime() + 1000),
      },
    });
  }
}

async function main() {
  console.log("Seeding flake-detection fixture…");

  const base = new Date("2026-03-01T08:00:00Z");
  const day  = (n: number) => new Date(base.getTime() + n * 86_400_000);

  // ── 10 runs spread over 10 days ──────────────────────────────────────────
  const runs = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      makeRun(500 + i, day(i), i < 2 ? "FAILED" : "PASSED")
    )
  );

  // A) Consistently passing — 10 × PASSED (score=0.0)
  for (const run of runs) {
    await makeExec(run.id,
      "tests/auth/login.spec.ts::Login > happy path",
      "chromium", "PASSED",
      [{ status: "passed", retry: 0 }]
    );
  }

  // B) Infra-flaky: timeout errors on 8 runs, passes on 2 (score≈0.4 → INFRA)
  const timeoutMsg = "Error: page.click: Timeout 30000ms exceeded.\nWaiting for selector '#checkout-btn'";
  for (const [i, run] of runs.entries()) {
    const isPass = i === 4 || i === 7;
    await makeExec(run.id,
      "tests/checkout/payment.spec.ts::Checkout > payment timeout",
      "chromium",
      isPass ? "PASSED" : "FAILED",
      isPass
        ? [{ status: "passed", retry: 0 }]
        : [{ status: "failed", errorMsg: timeoutMsg, retry: 0 }]
    );
  }

  // C) Test-code flaky: mix of pass/fail/flaky with varied error hashes (→ TEST_CODE)
  const errA = "AssertionError: Expected selector '.confirm-btn' to be visible";
  const errB = "Error: expect(received).toBe(expected)  Expected: 'Sent'  Received: 'Sending'";
  const errC = "ElementHandle.click: Element is intercepted by another element";
  const patternC = ["PASSED", "FAILED", "PASSED", "FLAKY", "PASSED", "FAILED", "PASSED", "FLAKY", "PASSED", "FAILED"];
  const errorByPattern = { FAILED: [errA, errB, errC], FLAKY: [errC] };
  for (const [i, run] of runs.entries()) {
    const st = patternC[i];
    const errMsg = st === "PASSED" ? undefined : errorByPattern[st as "FAILED"|"FLAKY"][ i % 3];
    await makeExec(run.id,
      "tests/invite/send.spec.ts::Invite > send button click",
      "chromium",
      st,
      st === "FLAKY"
        ? [
            { status: "failed", errorMsg: errMsg, retry: 0 },
            { status: "passed", retry: 1 },
          ]
        : [{ status: st === "PASSED" ? "passed" : "failed", errorMsg: errMsg, retry: 0 }]
    );
  }

  // D) Product-bug flaky: consistent error hash (same message every time → PRODUCT_BUG)
  const consistentErr = "Error: Concurrent update detected. Expected version 4, got 3.";
  const patternD = ["PASSED", "FLAKY", "PASSED", "PASSED", "FLAKY", "PASSED", "FLAKY", "PASSED", "PASSED", "FLAKY"];
  for (const [i, run] of runs.entries()) {
    const st = patternD[i];
    await makeExec(run.id,
      "tests/rsvp/update.spec.ts::RSVP > concurrent update",
      "chromium",
      st,
      st === "FLAKY"
        ? [
            { status: "failed", errorMsg: consistentErr, retry: 0 },
            { status: "passed", retry: 1 },
          ]
        : [{ status: "passed", retry: 0 }]
    );
  }

  // E) Too few runs — only 3 (will be skipped by min-runs=5)
  for (const run of runs.slice(0, 3)) {
    await makeExec(run.id,
      "tests/search/filter.spec.ts::Search > filter panel",
      "chromium", "FAILED",
      [{ status: "failed", errorMsg: "Filter not responding", retry: 0 }]
    );
  }

  console.log("  ✓ 10 CiRun rows");
  console.log("  ✓ Scenario A: 10 × PASSED (healthy)");
  console.log("  ✓ Scenario B: 8 FAILED + 2 PASSED → INFRA");
  console.log("  ✓ Scenario C: mixed P/F/K + varied errors → TEST_CODE");
  console.log("  ✓ Scenario D: PASSED + FLAKY (consistent error) → PRODUCT_BUG");
  console.log("  ✓ Scenario E: 3 runs only → skipped by min-runs threshold");
  console.log("\nNow run:  npm run analyze:flakes -- --min-runs 5 --explain");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
