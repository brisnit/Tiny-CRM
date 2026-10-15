-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CalendarEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "meetingUrl" TEXT,
    "startAt" DATETIME NOT NULL,
    "endAt" DATETIME NOT NULL,
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "organizerId" TEXT,
    "prepBrief" TEXT,
    "recap" TEXT,
    "contactId" TEXT,
    "companyId" TEXT,
    "dealId" TEXT,
    "projectId" TEXT,
    "integrationId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "ownerUserId" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'workspace',
    "sharedAt" DATETIME,
    "sharedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CalendarEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CalendarEvent_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CalendarEvent_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CalendarEvent_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CalendarEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CalendarEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CalendarEvent_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CalendarEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_CalendarEvent" ("allDay", "companyId", "contactId", "createdAt", "dealId", "description", "endAt", "externalId", "id", "location", "meetingUrl", "organizerId", "prepBrief", "projectId", "provider", "recap", "startAt", "title", "updatedAt", "workspaceId") SELECT "allDay", "companyId", "contactId", "createdAt", "dealId", "description", "endAt", "externalId", "id", "location", "meetingUrl", "organizerId", "prepBrief", "projectId", "provider", "recap", "startAt", "title", "updatedAt", "workspaceId" FROM "CalendarEvent";
DROP TABLE "CalendarEvent";
ALTER TABLE "new_CalendarEvent" RENAME TO "CalendarEvent";
CREATE INDEX "CalendarEvent_workspaceId_startAt_idx" ON "CalendarEvent"("workspaceId", "startAt");
CREATE INDEX "CalendarEvent_projectId_startAt_idx" ON "CalendarEvent"("projectId", "startAt");
CREATE INDEX "CalendarEvent_contactId_startAt_idx" ON "CalendarEvent"("contactId", "startAt");
CREATE INDEX "CalendarEvent_integrationId_startAt_idx" ON "CalendarEvent"("integrationId", "startAt");
CREATE INDEX "CalendarEvent_ownerUserId_startAt_idx" ON "CalendarEvent"("ownerUserId", "startAt");
CREATE UNIQUE INDEX "CalendarEvent_workspaceId_ownerUserId_provider_externalId_key" ON "CalendarEvent"("workspaceId", "ownerUserId", "provider", "externalId");
CREATE TABLE "new_EmailMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "externalId" TEXT,
    "threadId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "body" TEXT,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "toJson" TEXT NOT NULL DEFAULT '[]',
    "direction" TEXT NOT NULL DEFAULT 'inbound',
    "sentAt" DATETIME NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "needsReply" BOOLEAN NOT NULL DEFAULT false,
    "contactId" TEXT,
    "companyId" TEXT,
    "dealId" TEXT,
    "projectId" TEXT,
    "integrationId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'seed',
    "ownerUserId" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'workspace',
    "sharedAt" DATETIME,
    "sharedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EmailMessage_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "EmailMessage_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "EmailMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "EmailMessage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "EmailMessage_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "EmailMessage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_EmailMessage" ("body", "companyId", "contactId", "createdAt", "dealId", "direction", "externalId", "fromEmail", "fromName", "id", "isRead", "needsReply", "projectId", "provider", "sentAt", "snippet", "subject", "threadId", "toJson", "workspaceId") SELECT "body", "companyId", "contactId", "createdAt", "dealId", "direction", "externalId", "fromEmail", "fromName", "id", "isRead", "needsReply", "projectId", "provider", "sentAt", "snippet", "subject", "threadId", "toJson", "workspaceId" FROM "EmailMessage";
DROP TABLE "EmailMessage";
ALTER TABLE "new_EmailMessage" RENAME TO "EmailMessage";
CREATE INDEX "EmailMessage_workspaceId_sentAt_idx" ON "EmailMessage"("workspaceId", "sentAt");
CREATE INDEX "EmailMessage_threadId_sentAt_idx" ON "EmailMessage"("threadId", "sentAt");
CREATE INDEX "EmailMessage_contactId_sentAt_idx" ON "EmailMessage"("contactId", "sentAt");
CREATE INDEX "EmailMessage_workspaceId_needsReply_idx" ON "EmailMessage"("workspaceId", "needsReply");
CREATE INDEX "EmailMessage_integrationId_sentAt_idx" ON "EmailMessage"("integrationId", "sentAt");
CREATE INDEX "EmailMessage_ownerUserId_sentAt_idx" ON "EmailMessage"("ownerUserId", "sentAt");
CREATE UNIQUE INDEX "EmailMessage_workspaceId_ownerUserId_provider_externalId_key" ON "EmailMessage"("workspaceId", "ownerUserId", "provider", "externalId");
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
    "lastError" TEXT,
    "lastErrorAt" DATETIME,
    "syncGeneration" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Integration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Integration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Integration" ("accountEmail", "connectedAt", "credentials", "id", "lastSyncAt", "provider", "scopes", "status", "syncCursor", "userId", "workspaceId") SELECT "accountEmail", "connectedAt", "credentials", "id", "lastSyncAt", "provider", "scopes", "status", "syncCursor", "userId", "workspaceId" FROM "Integration";
DROP TABLE "Integration";
ALTER TABLE "new_Integration" RENAME TO "Integration";
CREATE INDEX "Integration_status_tokenExpiresAt_idx" ON "Integration"("status", "tokenExpiresAt");
CREATE UNIQUE INDEX "Integration_workspaceId_userId_provider_key" ON "Integration"("workspaceId", "userId", "provider");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
