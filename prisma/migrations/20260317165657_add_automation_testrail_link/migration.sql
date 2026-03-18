-- CreateTable
CREATE TABLE "automation_testrail_link" (
    "id" BIGSERIAL NOT NULL,
    "test_case_id" TEXT NOT NULL,
    "tr_case_id" BIGINT NOT NULL,
    "provenance" "LinkProvenance" NOT NULL,
    "confidence" "LinkConfidence" NOT NULL,
    "match_score" DOUBLE PRECISION,
    "evidence" TEXT,
    "source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_testrail_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automation_tr_link_test_idx" ON "automation_testrail_link"("test_case_id");

-- CreateIndex
CREATE INDEX "automation_tr_link_tr_idx" ON "automation_testrail_link"("tr_case_id");

-- CreateIndex
CREATE UNIQUE INDEX "automation_tr_link_uq" ON "automation_testrail_link"("test_case_id", "tr_case_id", "provenance");

-- AddForeignKey
ALTER TABLE "automation_testrail_link" ADD CONSTRAINT "automation_testrail_link_test_case_id_fkey" FOREIGN KEY ("test_case_id") REFERENCES "TestCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_testrail_link" ADD CONSTRAINT "automation_testrail_link_tr_case_id_fkey" FOREIGN KEY ("tr_case_id") REFERENCES "testrail_case"("tr_case_id") ON DELETE CASCADE ON UPDATE CASCADE;
