-- CreateTable
CREATE TABLE "testrail_result" (
    "id" BIGSERIAL NOT NULL,
    "tr_result_id" BIGINT NOT NULL,
    "tr_run_id" BIGINT NOT NULL,
    "tr_case_id" BIGINT NOT NULL,
    "status_id" INTEGER NOT NULL,
    "tested_at" TIMESTAMP(3),

    CONSTRAINT "testrail_result_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "testrail_result_tr_result_id_key" ON "testrail_result"("tr_result_id");

-- CreateIndex
CREATE INDEX "testrail_result_run_idx" ON "testrail_result"("tr_run_id");

-- CreateIndex
CREATE INDEX "testrail_result_case_date_idx" ON "testrail_result"("tr_case_id", "tested_at");

-- AddForeignKey
ALTER TABLE "testrail_result" ADD CONSTRAINT "testrail_result_tr_case_id_fkey" FOREIGN KEY ("tr_case_id") REFERENCES "testrail_case"("tr_case_id") ON DELETE CASCADE ON UPDATE CASCADE;
