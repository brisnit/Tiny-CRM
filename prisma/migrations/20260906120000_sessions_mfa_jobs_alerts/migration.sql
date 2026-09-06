-- AlterTable
ALTER TABLE "AuthToken" ADD COLUMN "consumedBySessionId" TEXT;

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "worker" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "outcome" TEXT,
    "durationMs" INTEGER,
    "error" TEXT,
    CONSTRAINT "JobRun_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "DomainEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RateLimitCounter" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "count" INTEGER NOT NULL DEFAULT 0,
    "resetAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "revokedReason" TEXT,
    "ipPrefix" TEXT,
    "userAgent" TEXT,
    "deviceLabel" TEXT,
    CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MfaCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'totp',
    "secretEncrypted" TEXT NOT NULL,
    "confirmedAt" DATETIME,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedStep" INTEGER,
    CONSTRAINT "MfaCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MfaRecoveryCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MfaRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SecurityAlert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "summary" TEXT NOT NULL,
    "metadata" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedupeKey" TEXT NOT NULL,
    "acknowledgedAt" DATETIME,
    "acknowledgedById" TEXT,
    "deliveredAt" DATETIME,
    "deliveryError" TEXT,
    CONSTRAINT "SecurityAlert_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DomainEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "actorId" TEXT,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "processedAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedBy" TEXT,
    "claimedUntil" DATETIME,
    "lastError" TEXT,
    "deadAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DomainEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DomainEvent" ("actorId", "attempts", "createdAt", "entityId", "entityType", "id", "lastError", "name", "payload", "processedAt", "workspaceId") SELECT "actorId", "attempts", "createdAt", "entityId", "entityType", "id", "lastError", "name", "payload", "processedAt", "workspaceId" FROM "DomainEvent";
DROP TABLE "DomainEvent";
ALTER TABLE "new_DomainEvent" RENAME TO "DomainEvent";
CREATE INDEX "DomainEvent_status_availableAt_idx" ON "DomainEvent"("status", "availableAt");
CREATE INDEX "DomainEvent_processedAt_createdAt_idx" ON "DomainEvent"("processedAt", "createdAt");
CREATE INDEX "DomainEvent_workspaceId_name_createdAt_idx" ON "DomainEvent"("workspaceId", "name", "createdAt");
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT,
    "avatarUrl" TEXT,
    "jobTitle" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    "plan" TEXT NOT NULL DEFAULT 'free',
    "planStatus" TEXT NOT NULL DEFAULT 'active',
    "planRenewsAt" DATETIME,
    "billingCustomerId" TEXT,
    "onboardedAt" DATETIME,
    "lastSeenAt" DATETIME,
    "deactivatedAt" DATETIME,
    "emailVerifiedAt" DATETIME,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "sessionEpoch" INTEGER NOT NULL DEFAULT 0,
    "mfaEnabledAt" DATETIME,
    "passwordChangedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("avatarUrl", "billingCustomerId", "createdAt", "deactivatedAt", "email", "emailVerifiedAt", "failedLoginCount", "id", "jobTitle", "lastSeenAt", "lockedUntil", "name", "onboardedAt", "passwordHash", "plan", "planRenewsAt", "planStatus", "timezone", "updatedAt") SELECT "avatarUrl", "billingCustomerId", "createdAt", "deactivatedAt", "email", "emailVerifiedAt", "failedLoginCount", "id", "jobTitle", "lastSeenAt", "lockedUntil", "name", "onboardedAt", "passwordHash", "plan", "planRenewsAt", "planStatus", "timezone", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_plan_idx" ON "User"("plan");
CREATE INDEX "User_deactivatedAt_idx" ON "User"("deactivatedAt");
CREATE TABLE "new_Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#068C28',
    "description" TEXT,
    "ownerId" TEXT NOT NULL,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "aiMode" TEXT NOT NULL DEFAULT 'enabled',
    "deletionRequestedAt" DATETIME,
    "deletionRequestedById" TEXT,
    "deletionScheduledAt" DATETIME,
    CONSTRAINT "Workspace_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Workspace" ("archivedAt", "color", "createdAt", "description", "id", "name", "ownerId", "slug", "updatedAt") SELECT "archivedAt", "color", "createdAt", "description", "id", "name", "ownerId", "slug", "updatedAt" FROM "Workspace";
DROP TABLE "Workspace";
ALTER TABLE "new_Workspace" RENAME TO "Workspace";
CREATE INDEX "Workspace_ownerId_archivedAt_idx" ON "Workspace"("ownerId", "archivedAt");
CREATE INDEX "Workspace_deletionScheduledAt_idx" ON "Workspace"("deletionScheduledAt");
CREATE UNIQUE INDEX "Workspace_ownerId_slug_key" ON "Workspace"("ownerId", "slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "JobRun_eventId_attempt_idx" ON "JobRun"("eventId", "attempt");

-- CreateIndex
CREATE INDEX "JobRun_startedAt_idx" ON "JobRun"("startedAt");

-- CreateIndex
CREATE INDEX "RateLimitCounter_resetAt_idx" ON "RateLimitCounter"("resetAt");

-- CreateIndex
CREATE UNIQUE INDEX "UserSession_tokenHash_key" ON "UserSession"("tokenHash");

-- CreateIndex
CREATE INDEX "UserSession_userId_revokedAt_lastSeenAt_idx" ON "UserSession"("userId", "revokedAt", "lastSeenAt");

-- CreateIndex
CREATE INDEX "UserSession_expiresAt_idx" ON "UserSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MfaCredential_userId_type_key" ON "MfaCredential"("userId", "type");

-- CreateIndex
CREATE INDEX "MfaRecoveryCode_userId_usedAt_idx" ON "MfaRecoveryCode"("userId", "usedAt");

-- CreateIndex
CREATE INDEX "SecurityAlert_workspaceId_lastSeenAt_idx" ON "SecurityAlert"("workspaceId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "SecurityAlert_severity_acknowledgedAt_lastSeenAt_idx" ON "SecurityAlert"("severity", "acknowledgedAt", "lastSeenAt");

-- CreateIndex
CREATE INDEX "SecurityAlert_deliveredAt_idx" ON "SecurityAlert"("deliveredAt");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityAlert_dedupeKey_key" ON "SecurityAlert"("dedupeKey");

