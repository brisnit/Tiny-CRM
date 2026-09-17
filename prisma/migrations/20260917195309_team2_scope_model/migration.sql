-- CreateTable
CREATE TABLE "RecordGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "anchorType" TEXT NOT NULL,
    "anchorId" TEXT NOT NULL,
    "grantedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecordGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WorkspaceMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "scopeMode" TEXT NOT NULL DEFAULT 'workspace',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WorkspaceMember" ("createdAt", "id", "role", "userId", "workspaceId") SELECT "createdAt", "id", "role", "userId", "workspaceId" FROM "WorkspaceMember";
DROP TABLE "WorkspaceMember";
ALTER TABLE "new_WorkspaceMember" RENAME TO "WorkspaceMember";
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "RecordGrant_userId_workspaceId_anchorType_anchorId_idx" ON "RecordGrant"("userId", "workspaceId", "anchorType", "anchorId");

-- CreateIndex
CREATE INDEX "RecordGrant_workspaceId_anchorType_anchorId_idx" ON "RecordGrant"("workspaceId", "anchorType", "anchorId");

-- CreateIndex
CREATE UNIQUE INDEX "RecordGrant_workspaceId_userId_anchorType_anchorId_key" ON "RecordGrant"("workspaceId", "userId", "anchorType", "anchorId");
