-- CreateTable
CREATE TABLE "JiraIssue" (
    "issueKey" TEXT NOT NULL,
    "projectKey" TEXT NOT NULL,
    "issueType" TEXT NOT NULL,
    "summary" TEXT,
    "status" TEXT,
    "parentIssueKey" TEXT,
    "labels" TEXT[],
    "components" TEXT[],
    "fixVersions" TEXT[],
    "updatedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw" JSONB,

    CONSTRAINT "JiraIssue_pkey" PRIMARY KEY ("issueKey")
);

-- CreateTable
CREATE TABLE "TestRailCase" (
    "caseId" INTEGER NOT NULL,
    "projectId" INTEGER NOT NULL,
    "suiteId" INTEGER,
    "sectionId" INTEGER,
    "title" TEXT NOT NULL,
    "refs" TEXT,
    "updatedOn" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw" JSONB,

    CONSTRAINT "TestRailCase_pkey" PRIMARY KEY ("caseId")
);

-- CreateTable
CREATE TABLE "JiraToAutomationLink" (
    "id" TEXT NOT NULL,
    "jiraIssueKey" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "provenance" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "evidence" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JiraToAutomationLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JiraToTestRailLink" (
    "id" TEXT NOT NULL,
    "jiraIssueKey" TEXT NOT NULL,
    "testRailCaseId" INTEGER NOT NULL,
    "provenance" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "evidence" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JiraToTestRailLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JiraToAutomationLink_jiraIssueKey_testCaseId_isActive_key" ON "JiraToAutomationLink"("jiraIssueKey", "testCaseId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "JiraToTestRailLink_jiraIssueKey_testRailCaseId_isActive_key" ON "JiraToTestRailLink"("jiraIssueKey", "testRailCaseId", "isActive");

-- AddForeignKey
ALTER TABLE "JiraToAutomationLink" ADD CONSTRAINT "JiraToAutomationLink_jiraIssueKey_fkey" FOREIGN KEY ("jiraIssueKey") REFERENCES "JiraIssue"("issueKey") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JiraToAutomationLink" ADD CONSTRAINT "JiraToAutomationLink_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JiraToTestRailLink" ADD CONSTRAINT "JiraToTestRailLink_jiraIssueKey_fkey" FOREIGN KEY ("jiraIssueKey") REFERENCES "JiraIssue"("issueKey") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JiraToTestRailLink" ADD CONSTRAINT "JiraToTestRailLink_testRailCaseId_fkey" FOREIGN KEY ("testRailCaseId") REFERENCES "TestRailCase"("caseId") ON DELETE CASCADE ON UPDATE CASCADE;
