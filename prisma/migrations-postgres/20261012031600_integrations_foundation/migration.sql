-- Integration foundations: tenant-scoped de-duplication, provenance,
-- per-owner visibility and connection lifecycle.
--
-- Additive. Every new column carries a default, so this applies to a table
-- that already has rows — rehearsed against a non-empty Integration table.
--
-- Two things worth knowing before applying this:
--
--   1. **It adds four foreign keys** (EmailMessage and CalendarEvent, each to
--      Integration and to User). 003_deferrable_constraints.sql is not part of
--      the migration history and only affects the foreign keys that exist when
--      it runs, so it MUST be re-applied afterwards or the deployment gate will
--      refuse the next production build. That is not hypothetical: it blocked
--      the owner-admin panel release for exactly this reason.
--
--   2. **The unique index swap is a tightening in one direction only.** The old
--      index was (provider, externalId) across every tenant, which is strictly
--      narrower than (workspaceId, provider, externalId) — so no existing row
--      can violate the new one and the CREATE cannot fail on duplicates. The
--      old index is what made a shared calendar event importable by exactly one
--      customer: the same Google event id appears in every invitee's calendar.
--
-- Nothing is backfilled. Existing rows keep source='seed' and
-- visibility='workspace', which is what they are: seeded demonstration data
-- that the whole workspace already sees. Imported rows are written with
-- source='imported' and visibility='private' by the sync worker.

-- DropIndex
DROP INDEX "CalendarEvent_provider_externalId_key";

-- DropIndex
DROP INDEX "EmailMessage_provider_externalId_key";

-- AlterTable
ALTER TABLE "CalendarEvent" ADD COLUMN     "integrationId" TEXT,
ADD COLUMN     "ownerUserId" TEXT,
ADD COLUMN     "sharedAt" TIMESTAMP(3),
ADD COLUMN     "sharedById" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'seed',
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'workspace';

-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN     "integrationId" TEXT,
ADD COLUMN     "ownerUserId" TEXT,
ADD COLUMN     "sharedAt" TIMESTAMP(3),
ADD COLUMN     "sharedById" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'seed',
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'workspace';

-- AlterTable
ALTER TABLE "Integration" ADD COLUMN     "backfillCompletedAt" TIMESTAMP(3),
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "disconnectedAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastErrorAt" TIMESTAMP(3),
ADD COLUMN     "syncGeneration" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "syncState" TEXT NOT NULL DEFAULT 'idle',
ADD COLUMN     "tokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "CalendarEvent_integrationId_startAt_idx" ON "CalendarEvent"("integrationId", "startAt");

-- CreateIndex
CREATE INDEX "CalendarEvent_ownerUserId_startAt_idx" ON "CalendarEvent"("ownerUserId", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEvent_workspaceId_provider_externalId_key" ON "CalendarEvent"("workspaceId", "provider", "externalId");

-- CreateIndex
CREATE INDEX "EmailMessage_integrationId_sentAt_idx" ON "EmailMessage"("integrationId", "sentAt");

-- CreateIndex
CREATE INDEX "EmailMessage_ownerUserId_sentAt_idx" ON "EmailMessage"("ownerUserId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_workspaceId_provider_externalId_key" ON "EmailMessage"("workspaceId", "provider", "externalId");

-- CreateIndex
CREATE INDEX "Integration_status_tokenExpiresAt_idx" ON "Integration"("status", "tokenExpiresAt");

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

