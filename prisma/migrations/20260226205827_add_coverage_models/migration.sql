/*
  Warnings:

  - You are about to drop the `JiraIssue` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JiraToAutomationLink` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JiraToTestRailLink` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TestRailCase` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "LinkProvenance" AS ENUM ('EXPLICIT', 'INFERRED', 'MANUAL');

-- CreateEnum
CREATE TYPE "LinkConfidence" AS ENUM ('HIGH', 'MED', 'LOW');

-- DropForeignKey
ALTER TABLE "JiraToAutomationLink" DROP CONSTRAINT "JiraToAutomationLink_jiraIssueKey_fkey";

-- DropForeignKey
ALTER TABLE "JiraToAutomationLink" DROP CONSTRAINT "JiraToAutomationLink_testCaseId_fkey";

-- DropForeignKey
ALTER TABLE "JiraToTestRailLink" DROP CONSTRAINT "JiraToTestRailLink_jiraIssueKey_fkey";

-- DropForeignKey
ALTER TABLE "JiraToTestRailLink" DROP CONSTRAINT "JiraToTestRailLink_testRailCaseId_fkey";

-- DropTable
DROP TABLE "JiraIssue";

-- DropTable
DROP TABLE "JiraToAutomationLink";

-- DropTable
DROP TABLE "JiraToTestRailLink";

-- DropTable
DROP TABLE "TestRailCase";

-- CreateTable
CREATE TABLE "jira_issue" (
    "id" BIGSERIAL NOT NULL,
    "issue_key" TEXT NOT NULL,
    "issue_type" TEXT NOT NULL,
    "summary" TEXT,
    "status" TEXT,
    "parent_key" TEXT,
    "project_key" TEXT,
    "priority" TEXT,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "raw" JSONB,

    CONSTRAINT "jira_issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "testrail_case" (
    "id" BIGSERIAL NOT NULL,
    "tr_case_id" BIGINT NOT NULL,
    "title" TEXT,
    "section_path" TEXT,
    "suite_id" BIGINT,
    "priority" TEXT,
    "refs" TEXT,
    "custom" JSONB,
    "raw" JSONB,

    CONSTRAINT "testrail_case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jira_automation_link" (
    "id" BIGSERIAL NOT NULL,
    "issue_key" TEXT NOT NULL,
    "test_case_id" TEXT NOT NULL,
    "provenance" "LinkProvenance" NOT NULL,
    "confidence" "LinkConfidence" NOT NULL,
    "evidence" TEXT,
    "source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jira_automation_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jira_testrail_link" (
    "id" BIGSERIAL NOT NULL,
    "issue_key" TEXT NOT NULL,
    "tr_case_id" BIGINT NOT NULL,
    "provenance" "LinkProvenance" NOT NULL,
    "confidence" "LinkConfidence" NOT NULL,
    "evidence" TEXT,
    "source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jira_testrail_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "jira_issue_issue_key_key" ON "jira_issue"("issue_key");

-- CreateIndex
CREATE INDEX "jira_issue_project_idx" ON "jira_issue"("project_key");

-- CreateIndex
CREATE INDEX "jira_issue_type_idx" ON "jira_issue"("issue_type");

-- CreateIndex
CREATE INDEX "jira_issue_status_idx" ON "jira_issue"("status");

-- CreateIndex
CREATE INDEX "jira_issue_parent_idx" ON "jira_issue"("parent_key");

-- CreateIndex
CREATE UNIQUE INDEX "testrail_case_tr_case_id_key" ON "testrail_case"("tr_case_id");

-- CreateIndex
CREATE INDEX "testrail_case_suite_idx" ON "testrail_case"("suite_id");

-- CreateIndex
CREATE INDEX "testrail_case_section_idx" ON "testrail_case"("section_path");

-- CreateIndex
CREATE INDEX "jira_automation_link_issue_idx" ON "jira_automation_link"("issue_key");

-- CreateIndex
CREATE INDEX "jira_automation_link_test_idx" ON "jira_automation_link"("test_case_id");

-- CreateIndex
CREATE UNIQUE INDEX "jira_automation_link_uq" ON "jira_automation_link"("issue_key", "test_case_id", "provenance");

-- CreateIndex
CREATE INDEX "jira_testrail_link_issue_idx" ON "jira_testrail_link"("issue_key");

-- CreateIndex
CREATE INDEX "jira_testrail_link_case_idx" ON "jira_testrail_link"("tr_case_id");

-- CreateIndex
CREATE UNIQUE INDEX "jira_testrail_link_uq" ON "jira_testrail_link"("issue_key", "tr_case_id", "provenance");

-- AddForeignKey
ALTER TABLE "jira_automation_link" ADD CONSTRAINT "jira_automation_link_issue_key_fkey" FOREIGN KEY ("issue_key") REFERENCES "jira_issue"("issue_key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jira_automation_link" ADD CONSTRAINT "jira_automation_link_test_case_id_fkey" FOREIGN KEY ("test_case_id") REFERENCES "TestCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jira_testrail_link" ADD CONSTRAINT "jira_testrail_link_issue_key_fkey" FOREIGN KEY ("issue_key") REFERENCES "jira_issue"("issue_key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jira_testrail_link" ADD CONSTRAINT "jira_testrail_link_tr_case_id_fkey" FOREIGN KEY ("tr_case_id") REFERENCES "testrail_case"("tr_case_id") ON DELETE CASCADE ON UPDATE CASCADE;
