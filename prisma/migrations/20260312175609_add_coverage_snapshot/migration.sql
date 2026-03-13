-- CreateTable
CREATE TABLE "coverage_snapshot" (
    "id" BIGSERIAL NOT NULL,
    "taken_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total_issues" INTEGER NOT NULL,
    "auto_executed_30d" INTEGER NOT NULL,
    "auto_executed_30d_pct" DOUBLE PRECISION NOT NULL,
    "auto_executed_7d" INTEGER NOT NULL,
    "auto_executed_7d_pct" DOUBLE PRECISION NOT NULL,
    "linked_but_stale_30d" INTEGER NOT NULL,
    "fully_uncovered" INTEGER NOT NULL,
    "manual_executed_30d" INTEGER NOT NULL,
    "manual_executed_30d_pct" DOUBLE PRECISION NOT NULL,
    "manual_executed_7d" INTEGER NOT NULL,
    "manual_executed_7d_pct" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "coverage_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coverage_snapshot_taken_at_idx" ON "coverage_snapshot"("taken_at");
