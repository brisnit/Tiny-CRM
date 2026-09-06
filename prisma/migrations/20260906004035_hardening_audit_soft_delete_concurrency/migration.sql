-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "summary" TEXT NOT NULL,
    "metadata" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuthToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestIp" TEXT,
    CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "workspaceId" TEXT,
    "userId" TEXT,
    "result" TEXT,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DomainEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "actorId" TEXT,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "processedAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DomainEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "workspaceId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FeatureFlag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Activity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "direction" TEXT,
    "durationMin" INTEGER,
    "meta" TEXT,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "contactId" TEXT,
    "companyId" TEXT,
    "dealId" TEXT,
    "projectId" TEXT,
    "opportunityId" TEXT,
    "taskId" TEXT,
    "noteId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Activity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Activity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Activity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Activity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Activity_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Activity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Activity_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Activity_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Activity_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Activity" ("actorId", "body", "companyId", "contactId", "createdAt", "dealId", "direction", "durationMin", "id", "meta", "noteId", "occurredAt", "opportunityId", "projectId", "taskId", "title", "type", "workspaceId") SELECT "actorId", "body", "companyId", "contactId", "createdAt", "dealId", "direction", "durationMin", "id", "meta", "noteId", "occurredAt", "opportunityId", "projectId", "taskId", "title", "type", "workspaceId" FROM "Activity";
DROP TABLE "Activity";
ALTER TABLE "new_Activity" RENAME TO "Activity";
CREATE INDEX "Activity_workspaceId_occurredAt_idx" ON "Activity"("workspaceId", "occurredAt");
CREATE INDEX "Activity_contactId_occurredAt_idx" ON "Activity"("contactId", "occurredAt");
CREATE INDEX "Activity_companyId_occurredAt_idx" ON "Activity"("companyId", "occurredAt");
CREATE INDEX "Activity_dealId_occurredAt_idx" ON "Activity"("dealId", "occurredAt");
CREATE INDEX "Activity_projectId_occurredAt_idx" ON "Activity"("projectId", "occurredAt");
CREATE INDEX "Activity_opportunityId_occurredAt_idx" ON "Activity"("opportunityId", "occurredAt");
CREATE INDEX "Activity_workspaceId_type_occurredAt_idx" ON "Activity"("workspaceId", "type", "occurredAt");
CREATE TABLE "new_Company" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "logoUrl" TEXT,
    "industry" TEXT,
    "website" TEXT,
    "size" TEXT,
    "location" TEXT,
    "revenueRange" TEXT,
    "type" TEXT,
    "leadSource" TEXT,
    "relationshipStatus" TEXT NOT NULL DEFAULT 'prospect',
    "description" TEXT,
    "ownerId" TEXT,
    "primaryContactId" TEXT,
    "lastActivityAt" DATETIME,
    "archivedAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Company_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Company_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Company_primaryContactId_fkey" FOREIGN KEY ("primaryContactId") REFERENCES "Contact" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Company" ("archivedAt", "createdAt", "description", "domain", "id", "industry", "lastActivityAt", "leadSource", "location", "logoUrl", "name", "ownerId", "primaryContactId", "relationshipStatus", "revenueRange", "size", "type", "updatedAt", "website", "workspaceId") SELECT "archivedAt", "createdAt", "description", "domain", "id", "industry", "lastActivityAt", "leadSource", "location", "logoUrl", "name", "ownerId", "primaryContactId", "relationshipStatus", "revenueRange", "size", "type", "updatedAt", "website", "workspaceId" FROM "Company";
DROP TABLE "Company";
ALTER TABLE "new_Company" RENAME TO "Company";
CREATE UNIQUE INDEX "Company_primaryContactId_key" ON "Company"("primaryContactId");
CREATE INDEX "Company_workspaceId_name_idx" ON "Company"("workspaceId", "name");
CREATE INDEX "Company_workspaceId_archivedAt_lastActivityAt_idx" ON "Company"("workspaceId", "archivedAt", "lastActivityAt");
CREATE INDEX "Company_workspaceId_relationshipStatus_idx" ON "Company"("workspaceId", "relationshipStatus");
CREATE INDEX "Company_ownerId_idx" ON "Company"("ownerId");
CREATE TABLE "new_Contact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "jobTitle" TEXT,
    "companyId" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "linkedin" TEXT,
    "location" TEXT,
    "relationshipType" TEXT NOT NULL DEFAULT 'prospect',
    "leadSource" TEXT,
    "ownerId" TEXT,
    "importance" INTEGER,
    "description" TEXT,
    "lastContactedAt" DATETIME,
    "nextFollowUpAt" DATETIME,
    "archivedAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Contact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Contact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Contact_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Contact" ("archivedAt", "companyId", "createdAt", "description", "email", "firstName", "fullName", "id", "importance", "jobTitle", "lastContactedAt", "lastName", "leadSource", "linkedin", "location", "nextFollowUpAt", "ownerId", "phone", "relationshipType", "updatedAt", "website", "workspaceId") SELECT "archivedAt", "companyId", "createdAt", "description", "email", "firstName", "fullName", "id", "importance", "jobTitle", "lastContactedAt", "lastName", "leadSource", "linkedin", "location", "nextFollowUpAt", "ownerId", "phone", "relationshipType", "updatedAt", "website", "workspaceId" FROM "Contact";
DROP TABLE "Contact";
ALTER TABLE "new_Contact" RENAME TO "Contact";
CREATE INDEX "Contact_workspaceId_fullName_idx" ON "Contact"("workspaceId", "fullName");
CREATE INDEX "Contact_workspaceId_archivedAt_lastContactedAt_idx" ON "Contact"("workspaceId", "archivedAt", "lastContactedAt");
CREATE INDEX "Contact_workspaceId_nextFollowUpAt_idx" ON "Contact"("workspaceId", "nextFollowUpAt");
CREATE INDEX "Contact_companyId_idx" ON "Contact"("companyId");
CREATE INDEX "Contact_ownerId_idx" ON "Contact"("ownerId");
CREATE INDEX "Contact_workspaceId_email_idx" ON "Contact"("workspaceId", "email");
CREATE TABLE "new_Deal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "companyId" TEXT,
    "primaryContactId" TEXT,
    "projectId" TEXT,
    "pipelineId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "valueCents" INTEGER NOT NULL DEFAULT 0,
    "probability" INTEGER,
    "expectedCloseAt" DATETIME,
    "ownerId" TEXT,
    "source" TEXT,
    "nextStep" TEXT,
    "stageEnteredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" DATETIME,
    "closedAt" DATETIME,
    "lostReason" TEXT,
    "archivedAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Deal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Deal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Deal_primaryContactId_fkey" FOREIGN KEY ("primaryContactId") REFERENCES "Contact" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Deal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Deal_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Deal_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "PipelineStage" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Deal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Deal" ("archivedAt", "closedAt", "companyId", "createdAt", "expectedCloseAt", "id", "lastActivityAt", "lostReason", "name", "nextStep", "ownerId", "pipelineId", "primaryContactId", "probability", "projectId", "source", "stageEnteredAt", "stageId", "updatedAt", "valueCents", "workspaceId") SELECT "archivedAt", "closedAt", "companyId", "createdAt", "expectedCloseAt", "id", "lastActivityAt", "lostReason", "name", "nextStep", "ownerId", "pipelineId", "primaryContactId", "probability", "projectId", "source", "stageEnteredAt", "stageId", "updatedAt", "valueCents", "workspaceId" FROM "Deal";
DROP TABLE "Deal";
ALTER TABLE "new_Deal" RENAME TO "Deal";
CREATE INDEX "Deal_workspaceId_archivedAt_stageId_idx" ON "Deal"("workspaceId", "archivedAt", "stageId");
CREATE INDEX "Deal_pipelineId_stageId_idx" ON "Deal"("pipelineId", "stageId");
CREATE INDEX "Deal_workspaceId_expectedCloseAt_idx" ON "Deal"("workspaceId", "expectedCloseAt");
CREATE INDEX "Deal_workspaceId_lastActivityAt_idx" ON "Deal"("workspaceId", "lastActivityAt");
CREATE INDEX "Deal_companyId_idx" ON "Deal"("companyId");
CREATE INDEX "Deal_projectId_idx" ON "Deal"("projectId");
CREATE INDEX "Deal_ownerId_idx" ON "Deal"("ownerId");
CREATE TABLE "new_FileAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "storageKey" TEXT NOT NULL,
    "uploaderId" TEXT,
    "contactId" TEXT,
    "companyId" TEXT,
    "dealId" TEXT,
    "projectId" TEXT,
    "opportunityId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FileAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FileAsset_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FileAsset_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FileAsset_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FileAsset_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FileAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "FileAsset_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_FileAsset" ("companyId", "contactId", "createdAt", "dealId", "id", "mimeType", "name", "opportunityId", "projectId", "sizeBytes", "storageKey", "uploaderId", "workspaceId") SELECT "companyId", "contactId", "createdAt", "dealId", "id", "mimeType", "name", "opportunityId", "projectId", "sizeBytes", "storageKey", "uploaderId", "workspaceId" FROM "FileAsset";
DROP TABLE "FileAsset";
ALTER TABLE "new_FileAsset" RENAME TO "FileAsset";
CREATE INDEX "FileAsset_workspaceId_createdAt_idx" ON "FileAsset"("workspaceId", "createdAt");
CREATE INDEX "FileAsset_projectId_idx" ON "FileAsset"("projectId");
CREATE INDEX "FileAsset_dealId_idx" ON "FileAsset"("dealId");
CREATE INDEX "FileAsset_companyId_idx" ON "FileAsset"("companyId");
CREATE INDEX "FileAsset_contactId_idx" ON "FileAsset"("contactId");
CREATE INDEX "FileAsset_opportunityId_idx" ON "FileAsset"("opportunityId");
CREATE TABLE "new_Note" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL DEFAULT '',
    "plainText" TEXT NOT NULL DEFAULT '',
    "authorId" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "contactId" TEXT,
    "companyId" TEXT,
    "dealId" TEXT,
    "projectId" TEXT,
    "opportunityId" TEXT,
    "archivedAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Note_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Note_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Note_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Note_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Note_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Note_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Note_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Note" ("authorId", "body", "companyId", "contactId", "createdAt", "dealId", "id", "opportunityId", "pinned", "plainText", "projectId", "title", "updatedAt", "workspaceId") SELECT "authorId", "body", "companyId", "contactId", "createdAt", "dealId", "id", "opportunityId", "pinned", "plainText", "projectId", "title", "updatedAt", "workspaceId" FROM "Note";
DROP TABLE "Note";
ALTER TABLE "new_Note" RENAME TO "Note";
CREATE INDEX "Note_workspaceId_updatedAt_idx" ON "Note"("workspaceId", "updatedAt");
CREATE INDEX "Note_projectId_idx" ON "Note"("projectId");
CREATE INDEX "Note_contactId_idx" ON "Note"("contactId");
CREATE INDEX "Note_companyId_idx" ON "Note"("companyId");
CREATE INDEX "Note_dealId_idx" ON "Note"("dealId");
CREATE INDEX "Note_opportunityId_idx" ON "Note"("opportunityId");
CREATE TABLE "new_Opportunity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "companyId" TEXT,
    "projectId" TEXT,
    "pipelineId" TEXT,
    "stageId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'rfp',
    "source" TEXT,
    "solicitationNumber" TEXT,
    "postedAt" DATETIME,
    "questionsDeadlineAt" DATETIME,
    "proposalDeadlineAt" DATETIME,
    "deadlineAt" DATETIME,
    "estimatedValueCents" INTEGER,
    "fitScore" INTEGER,
    "strategicValue" TEXT,
    "competitionLevel" TEXT,
    "requirements" TEXT,
    "submissionStatus" TEXT NOT NULL DEFAULT 'not_started',
    "proposalUrl" TEXT,
    "ownerId" TEXT,
    "archivedAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Opportunity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Opportunity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Opportunity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Opportunity_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Opportunity_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "PipelineStage" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Opportunity_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Opportunity" ("archivedAt", "companyId", "competitionLevel", "createdAt", "deadlineAt", "estimatedValueCents", "fitScore", "id", "name", "ownerId", "pipelineId", "postedAt", "projectId", "proposalDeadlineAt", "proposalUrl", "questionsDeadlineAt", "requirements", "solicitationNumber", "source", "stageId", "strategicValue", "submissionStatus", "type", "updatedAt", "workspaceId") SELECT "archivedAt", "companyId", "competitionLevel", "createdAt", "deadlineAt", "estimatedValueCents", "fitScore", "id", "name", "ownerId", "pipelineId", "postedAt", "projectId", "proposalDeadlineAt", "proposalUrl", "questionsDeadlineAt", "requirements", "solicitationNumber", "source", "stageId", "strategicValue", "submissionStatus", "type", "updatedAt", "workspaceId" FROM "Opportunity";
DROP TABLE "Opportunity";
ALTER TABLE "new_Opportunity" RENAME TO "Opportunity";
CREATE INDEX "Opportunity_workspaceId_archivedAt_deadlineAt_idx" ON "Opportunity"("workspaceId", "archivedAt", "deadlineAt");
CREATE INDEX "Opportunity_workspaceId_submissionStatus_idx" ON "Opportunity"("workspaceId", "submissionStatus");
CREATE INDEX "Opportunity_pipelineId_stageId_idx" ON "Opportunity"("pipelineId", "stageId");
CREATE INDEX "Opportunity_companyId_idx" ON "Opportunity"("companyId");
CREATE INDEX "Opportunity_ownerId_idx" ON "Opportunity"("ownerId");
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "companyId" TEXT,
    "statusId" TEXT,
    "type" TEXT,
    "description" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "health" TEXT NOT NULL DEFAULT 'on_track',
    "ownerId" TEXT,
    "startDate" DATETIME,
    "targetDate" DATETIME,
    "completedAt" DATETIME,
    "budgetCents" INTEGER,
    "revenueCents" INTEGER,
    "nextAction" TEXT,
    "nextActionDueAt" DATETIME,
    "lastActivityAt" DATETIME,
    "archivedAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Project_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Project_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "ProjectStatus" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("archivedAt", "budgetCents", "companyId", "completedAt", "createdAt", "description", "health", "id", "lastActivityAt", "name", "nextAction", "nextActionDueAt", "ownerId", "priority", "revenueCents", "startDate", "statusId", "targetDate", "type", "updatedAt", "workspaceId") SELECT "archivedAt", "budgetCents", "companyId", "completedAt", "createdAt", "description", "health", "id", "lastActivityAt", "name", "nextAction", "nextActionDueAt", "ownerId", "priority", "revenueCents", "startDate", "statusId", "targetDate", "type", "updatedAt", "workspaceId" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE INDEX "Project_workspaceId_archivedAt_statusId_idx" ON "Project"("workspaceId", "archivedAt", "statusId");
CREATE INDEX "Project_workspaceId_health_idx" ON "Project"("workspaceId", "health");
CREATE INDEX "Project_workspaceId_targetDate_idx" ON "Project"("workspaceId", "targetDate");
CREATE INDEX "Project_companyId_idx" ON "Project"("companyId");
CREATE INDEX "Project_ownerId_idx" ON "Project"("ownerId");
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" TEXT,
    "dueAt" DATETIME,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'open',
    "completedAt" DATETIME,
    "recurrence" TEXT NOT NULL DEFAULT 'none',
    "reminderAt" DATETIME,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "contactId" TEXT,
    "companyId" TEXT,
    "dealId" TEXT,
    "projectId" TEXT,
    "opportunityId" TEXT,
    "archivedAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Task_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Task_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("companyId", "completedAt", "contactId", "createdAt", "dealId", "description", "dueAt", "id", "opportunityId", "ownerId", "priority", "projectId", "recurrence", "reminderAt", "sortOrder", "status", "title", "updatedAt", "workspaceId") SELECT "companyId", "completedAt", "contactId", "createdAt", "dealId", "description", "dueAt", "id", "opportunityId", "ownerId", "priority", "projectId", "recurrence", "reminderAt", "sortOrder", "status", "title", "updatedAt", "workspaceId" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE INDEX "Task_workspaceId_status_dueAt_idx" ON "Task"("workspaceId", "status", "dueAt");
CREATE INDEX "Task_ownerId_status_dueAt_idx" ON "Task"("ownerId", "status", "dueAt");
CREATE INDEX "Task_projectId_status_idx" ON "Task"("projectId", "status");
CREATE INDEX "Task_dealId_status_idx" ON "Task"("dealId", "status");
CREATE INDEX "Task_contactId_status_idx" ON "Task"("contactId", "status");
CREATE INDEX "Task_companyId_status_idx" ON "Task"("companyId", "status");
CREATE INDEX "Task_opportunityId_status_idx" ON "Task"("opportunityId", "status");
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("avatarUrl", "billingCustomerId", "createdAt", "email", "id", "jobTitle", "lastSeenAt", "name", "onboardedAt", "passwordHash", "plan", "planRenewsAt", "planStatus", "timezone", "updatedAt") SELECT "avatarUrl", "billingCustomerId", "createdAt", "email", "id", "jobTitle", "lastSeenAt", "name", "onboardedAt", "passwordHash", "plan", "planRenewsAt", "planStatus", "timezone", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_plan_idx" ON "User"("plan");
CREATE INDEX "User_deactivatedAt_idx" ON "User"("deactivatedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_action_createdAt_idx" ON "AuditLog"("workspaceId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON "AuthToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthToken_userId_purpose_expiresAt_idx" ON "AuthToken"("userId", "purpose", "expiresAt");

-- CreateIndex
CREATE INDEX "AuthToken_expiresAt_idx" ON "AuthToken"("expiresAt");

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_scope_key_key" ON "IdempotencyKey"("scope", "key");

-- CreateIndex
CREATE INDEX "DomainEvent_processedAt_createdAt_idx" ON "DomainEvent"("processedAt", "createdAt");

-- CreateIndex
CREATE INDEX "DomainEvent_workspaceId_name_createdAt_idx" ON "DomainEvent"("workspaceId", "name", "createdAt");

-- CreateIndex
CREATE INDEX "FeatureFlag_key_idx" ON "FeatureFlag"("key");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_key_workspaceId_key" ON "FeatureFlag"("key", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Automation_workspaceId_name_key" ON "Automation"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Pipeline_workspaceId_name_key" ON "Pipeline"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "SavedView_userId_entityType_name_key" ON "SavedView"("userId", "entityType", "name");

