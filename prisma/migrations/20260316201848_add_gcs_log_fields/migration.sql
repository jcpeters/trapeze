-- AlterTable
ALTER TABLE "TestAttempt" ADD COLUMN     "logUri" TEXT;

-- CreateTable
CREATE TABLE "BuildLog" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "logType" TEXT NOT NULL,
    "storageUri" TEXT NOT NULL,
    "bytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuildLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BuildLog_attemptId_idx" ON "BuildLog"("attemptId");

-- AddForeignKey
ALTER TABLE "BuildLog" ADD CONSTRAINT "BuildLog_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "TestAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
