import { PrismaClient, ResultStatus, ExecutionType } from '@prisma/client';
import { env } from './env.js';

import { prisma } from "./db/prisma";

async function main() {
  console.log('Seeding minimal dataset...');

  const jobName = 'qa-tests-mobile-web/qa-evite-tests-mw-acceptance';

  const build1 = await prisma.build.upsert({
    where: { build_unique_ci_job_number: { ciProvider: 'jenkins', jobName, buildNumber: 101 } },
    update: {},
    create: {
      ciProvider: 'jenkins',
      jobName,
      buildNumber: 101,
      buildUrl: 'https://jenkins.example/job/101',
      branch: 'main',
      gitSha: 'abc123',
      environment: 'staging',
      startedAt: new Date('2026-02-02T19:59:41Z'),
      finishedAt: new Date('2026-02-02T19:59:41Z')
    }
  });

  const build2 = await prisma.build.upsert({
    where: { build_unique_ci_job_number: { ciProvider: 'jenkins', jobName, buildNumber: 102 } },
    update: {},
    create: {
      ciProvider: 'jenkins',
      jobName,
      buildNumber: 102,
      buildUrl: 'https://jenkins.example/job/102',
      branch: 'main',
      gitSha: 'def456',
      environment: 'staging',
      startedAt: new Date('2026-02-03T19:59:41Z'),
      finishedAt: new Date('2026-02-03T19:59:41Z')
    }
  });

  const suite1 = await prisma.testSuite.create({
    data: {
      buildId: build1.id,
      suiteName: 'smoke',
      framework: 'pytest',
      durationMs: 180000
    }
  });

  const suite2 = await prisma.testSuite.create({
    data: {
      buildId: build2.id,
      suiteName: 'smoke',
      framework: 'pytest',
      durationMs: 160000
    }
  });

  const cases = [
    { identityKey: 'pytest::smoke::test_view_invitation', title: 'test_view_invitation', suiteName: 'smoke', filePath: 'tests/test_invite.py' },
    { identityKey: 'pytest::smoke::test_rsvp_yes', title: 'test_rsvp_yes', suiteName: 'smoke', filePath: 'tests/test_rsvp.py' },
    { identityKey: 'pytest::smoke::test_event_signups_locked', title: 'test_event_signups_locked', suiteName: 'smoke', filePath: 'tests/test_signups.py' },
  ] as const;

  const createdCases = [];
  for (const c of cases) {
    const tc = await prisma.testCase.upsert({
      where: { identityKey: c.identityKey },
      update: {
        title: c.title,
        suiteName: c.suiteName,
        filePath: c.filePath
      },
      create: {
        identityKey: c.identityKey,
        title: c.title,
        suiteName: c.suiteName,
        filePath: c.filePath
      }
    });
    createdCases.push(tc);
  }

  await prisma.testCaseResult.createMany({
    data: [
      {
        testCaseId: createdCases[0].id,
        buildId: build1.id,
        suiteId: suite1.id,
        executionType: ExecutionType.AUTOMATED,
        status: ResultStatus.PASSED,
        durationMs: 1200,
        attempt: 1
      },
      {
        testCaseId: createdCases[1].id,
        buildId: build1.id,
        suiteId: suite1.id,
        executionType: ExecutionType.AUTOMATED,
        status: ResultStatus.FAILED,
        durationMs: 2400,
        errorMessage: 'ElementNotInteractableException',
        attempt: 1,
        properties: { nodeid: 'tests/test_rsvp.py::test_rsvp_yes', marker: ['smoke'] }
      },
      {
        testCaseId: createdCases[2].id,
        buildId: build1.id,
        suiteId: suite1.id,
        executionType: ExecutionType.AUTOMATED,
        status: ResultStatus.PASSED,
        durationMs: 1800,
        attempt: 1
      }
    ]
  });

  await prisma.testCaseResult.createMany({
    data: [
      {
        testCaseId: createdCases[0].id,
        buildId: build2.id,
        suiteId: suite2.id,
        executionType: ExecutionType.AUTOMATED,
        status: ResultStatus.PASSED,
        durationMs: 1100,
        attempt: 1
      },
      {
        testCaseId: createdCases[1].id,
        buildId: build2.id,
        suiteId: suite2.id,
        executionType: ExecutionType.AUTOMATED,
        status: ResultStatus.PASSED,
        durationMs: 2000,
        attempt: 1,
        properties: { nodeid: 'tests/test_rsvp.py::test_rsvp_yes', marker: ['smoke'] }
      },
      {
        testCaseId: createdCases[2].id,
        buildId: build2.id,
        suiteId: suite2.id,
        executionType: ExecutionType.AUTOMATED,
        status: ResultStatus.PASSED,
        durationMs: 1700,
        attempt: 1
      }
    ]
  });

  await prisma.rawArtifact.createMany({
    data: [
      { buildId: build1.id, artifactType: 'junit-xml', storageUri: 'file://./sample/junit-build101.xml' },
      { buildId: build2.id, artifactType: 'junit-xml', storageUri: 'file://./sample/junit-build102.xml' },
    ]
  });

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
