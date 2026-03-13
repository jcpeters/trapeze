-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('PASSED', 'FAILED', 'SKIPPED', 'FLAKY', 'ERROR');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('PASSED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "FlakeClassification" AS ENUM ('INFRA', 'TEST_CODE', 'PRODUCT_BUG', 'UNKNOWN');

-- CreateTable
CREATE TABLE "CiRun" (
    "id" TEXT NOT NULL,
    "buildId" TEXT NOT NULL,
    "branch" TEXT,
    "gitSha" TEXT,
    "jobName" TEXT,
    "buildNumber" INTEGER,
    "prNumber" TEXT,
    "env" JSONB,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "status" "ExecutionStatus" NOT NULL,
    "project" TEXT,
    "shardIndex" INTEGER,
    "shardTotal" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CiRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestExecution" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "testCaseId" TEXT,
    "testId" TEXT NOT NULL,
    "filePath" TEXT,
    "titlePath" TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "project" TEXT,
    "shardIndex" INTEGER,
    "status" "ExecutionStatus" NOT NULL,
    "durationMs" INTEGER,
    "failureMsg" TEXT,
    "artifactLinks" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestAttempt" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "status" "AttemptStatus" NOT NULL,
    "durationMs" INTEGER,
    "errorHash" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlakeDecision" (
    "id" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "flakeScore" DOUBLE PRECISION NOT NULL,
    "classification" "FlakeClassification" NOT NULL,
    "recommendedAction" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlakeDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CiRun_buildId_idx" ON "CiRun"("buildId");

-- CreateIndex
CREATE INDEX "TestExecution_runId_idx" ON "TestExecution"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "TestExecution_runId_testId_project_shardIndex_key" ON "TestExecution"("runId", "testId", "project", "shardIndex");

-- CreateIndex
CREATE INDEX "TestAttempt_executionId_idx" ON "TestAttempt"("executionId");

-- CreateIndex
CREATE UNIQUE INDEX "TestAttempt_executionId_attemptNo_key" ON "TestAttempt"("executionId", "attemptNo");

-- CreateIndex
CREATE INDEX "FlakeDecision_testCaseId_idx" ON "FlakeDecision"("testCaseId");

-- AddForeignKey
ALTER TABLE "CiRun" ADD CONSTRAINT "CiRun_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestExecution" ADD CONSTRAINT "TestExecution_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CiRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestExecution" ADD CONSTRAINT "TestExecution_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestAttempt" ADD CONSTRAINT "TestAttempt_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "TestExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlakeDecision" ADD CONSTRAINT "FlakeDecision_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
