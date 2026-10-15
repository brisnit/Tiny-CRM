-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Integration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "accountEmail" TEXT,
    "scopes" TEXT,
    "credentials" TEXT,
    "tokenExpiresAt" DATETIME,
    "connectedAt" DATETIME,
    "disconnectedAt" DATETIME,
    "lastSyncAt" DATETIME,
    "syncCursor" TEXT,
    "syncState" TEXT NOT NULL DEFAULT 'idle',
    "backfillCompletedAt" DATETIME,
    "importedThrough" DATETIME,
    "backfillTruncated" BOOLEAN NOT NULL DEFAULT false,
    "pagesImported" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastErrorAt" DATETIME,
    "recoveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "syncGeneration" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Integration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Integration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Integration" ("accountEmail", "backfillCompletedAt", "backfillTruncated", "connectedAt", "createdAt", "credentials", "disconnectedAt", "id", "importedThrough", "lastError", "lastErrorAt", "lastSyncAt", "pagesImported", "provider", "scopes", "status", "syncCursor", "syncGeneration", "syncState", "tokenExpiresAt", "updatedAt", "userId", "workspaceId") SELECT "accountEmail", "backfillCompletedAt", "backfillTruncated", "connectedAt", "createdAt", "credentials", "disconnectedAt", "id", "importedThrough", "lastError", "lastErrorAt", "lastSyncAt", "pagesImported", "provider", "scopes", "status", "syncCursor", "syncGeneration", "syncState", "tokenExpiresAt", "updatedAt", "userId", "workspaceId" FROM "Integration";
DROP TABLE "Integration";
ALTER TABLE "new_Integration" RENAME TO "Integration";
CREATE INDEX "Integration_status_tokenExpiresAt_idx" ON "Integration"("status", "tokenExpiresAt");
CREATE UNIQUE INDEX "Integration_workspaceId_userId_provider_key" ON "Integration"("workspaceId", "userId", "provider");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
