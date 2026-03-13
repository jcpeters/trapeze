-- CreateEnum
CREATE TYPE "ExecutionType" AS ENUM ('AUTOMATED', 'MANUAL');

-- CreateEnum
CREATE TYPE "ResultStatus" AS ENUM ('PASSED', 'FAILED', 'SKIPPED', 'ERROR');

-- CreateTable
CREATE TABLE "Build" (
    "id" TEXT NOT NULL,
    "ciProvider" TEXT NOT NULL DEFAULT 'jenkins',
    "jobName" TEXT NOT NULL,
    "buildNumber" INTEGER NOT NULL,
    "buildUrl" TEXT,
    "gitSha" TEXT,
    "branch" TEXT,
    "environment" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Build_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestSuite" (
    "id" TEXT NOT NULL,
    "buildId" TEXT NOT NULL,
    "suiteName" TEXT NOT NULL,
    "framework" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestSuite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestCase" (
    "id" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "suiteName" TEXT,
    "filePath" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestCaseResult" (
    "id" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "buildId" TEXT NOT NULL,
    "suiteId" TEXT,
    "executionType" "ExecutionType" NOT NULL DEFAULT 'AUTOMATED',
    "status" "ResultStatus" NOT NULL,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "stackTrace" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "properties" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestCaseResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawArtifact" (
    "id" TEXT NOT NULL,
    "buildId" TEXT NOT NULL,
    "artifactType" TEXT NOT NULL,
    "storageUri" TEXT NOT NULL,
    "sha256" TEXT,
    "bytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RawArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Build_jobName_createdAt_idx" ON "Build"("jobName", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Build_ciProvider_jobName_buildNumber_key" ON "Build"("ciProvider", "jobName", "buildNumber");

-- CreateIndex
CREATE INDEX "TestSuite_buildId_idx" ON "TestSuite"("buildId");

-- CreateIndex
CREATE INDEX "TestSuite_suiteName_idx" ON "TestSuite"("suiteName");

-- CreateIndex
CREATE UNIQUE INDEX "TestCase_identityKey_key" ON "TestCase"("identityKey");

-- CreateIndex
CREATE INDEX "TestCase_title_idx" ON "TestCase"("title");

-- CreateIndex
CREATE INDEX "TestCaseResult_buildId_status_idx" ON "TestCaseResult"("buildId", "status");

-- CreateIndex
CREATE INDEX "TestCaseResult_testCaseId_createdAt_idx" ON "TestCaseResult"("testCaseId", "createdAt");

-- CreateIndex
CREATE INDEX "TestCaseResult_executionType_status_idx" ON "TestCaseResult"("executionType", "status");

-- CreateIndex
CREATE INDEX "RawArtifact_buildId_artifactType_idx" ON "RawArtifact"("buildId", "artifactType");

-- AddForeignKey
ALTER TABLE "TestSuite" ADD CONSTRAINT "TestSuite_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestCaseResult" ADD CONSTRAINT "TestCaseResult_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestCaseResult" ADD CONSTRAINT "TestCaseResult_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestCaseResult" ADD CONSTRAINT "TestCaseResult_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "TestSuite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawArtifact" ADD CONSTRAINT "RawArtifact_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build"("id") ON DELETE CASCADE ON UPDATE CASCADE;
