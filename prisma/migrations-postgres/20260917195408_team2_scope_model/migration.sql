-- AlterTable
ALTER TABLE "WorkspaceMember" ADD COLUMN     "scopeMode" TEXT NOT NULL DEFAULT 'workspace';

-- CreateTable
CREATE TABLE "RecordGrant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "anchorType" TEXT NOT NULL,
    "anchorId" TEXT NOT NULL,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecordGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecordGrant_userId_workspaceId_anchorType_anchorId_idx" ON "RecordGrant"("userId", "workspaceId", "anchorType", "anchorId");

-- CreateIndex
CREATE INDEX "RecordGrant_workspaceId_anchorType_anchorId_idx" ON "RecordGrant"("workspaceId", "anchorType", "anchorId");

-- CreateIndex
CREATE UNIQUE INDEX "RecordGrant_workspaceId_userId_anchorType_anchorId_key" ON "RecordGrant"("workspaceId", "userId", "anchorType", "anchorId");

-- AddForeignKey
ALTER TABLE "RecordGrant" ADD CONSTRAINT "RecordGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
