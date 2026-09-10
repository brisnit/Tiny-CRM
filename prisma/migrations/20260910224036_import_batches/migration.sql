-- AlterTable
ALTER TABLE "Company" ADD COLUMN "sourceBatchId" TEXT;

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN "sourceBatchId" TEXT;

-- AlterTable
ALTER TABLE "Opportunity" ADD COLUMN "sourceBatchId" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "sourceBatchId" TEXT;

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "actorId" TEXT,
    "sourceName" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sheetName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "mapping" TEXT NOT NULL DEFAULT '[]',
    "stats" TEXT NOT NULL DEFAULT '{}',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "committedAt" DATETIME,
    "rolledBackAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ImportBatch_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ImportBatch_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "rowIndex" INTEGER NOT NULL,
    "raw" TEXT NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT '{}',
    "decision" TEXT NOT NULL DEFAULT 'create',
    "issues" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "ImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ImportBatch_workspaceId_createdAt_idx" ON "ImportBatch"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ImportBatch_workspaceId_status_idx" ON "ImportBatch"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "ImportRow_batchId_decision_idx" ON "ImportRow"("batchId", "decision");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRow_batchId_rowIndex_key" ON "ImportRow"("batchId", "rowIndex");
