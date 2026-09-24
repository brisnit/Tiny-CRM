-- Document Intelligence: ingestion state and extracted chunks.
--
-- Two new tables and one new index on an existing one. Nothing is dropped,
-- nothing is rewritten, and no existing column changes type, so this applies to
-- a live database without taking anything offline.
--
-- WHY THE FOREIGN KEYS LOOK LIKE THAT
--
-- Both tables carry `workspaceId`, because every scoped table in this schema
-- does and because the row-level security policies are cheapest and clearest
-- when the workspace is a column rather than a join. A copied column is a
-- correctness risk: if a chunk could name workspace B while its file belongs to
-- workspace A, the policy would be asking the wrong row for permission.
--
-- So the copies are not trusted, they are constrained:
--
--   DocumentIngestion (fileAssetId, workspaceId)              -> FileAsset (id, workspaceId)
--   DocumentChunk     (ingestionId, fileAssetId, workspaceId) -> DocumentIngestion (id, fileAssetId, workspaceId)
--
-- A row whose workspace disagrees with its document is a foreign-key violation.
-- This is the device RecordGrant already uses to stop a grant naming one
-- membership while its user and workspace name another.
--
-- `FileAsset_id_workspaceId_key` exists to be the target of the first of those.
-- It is additive and duplicates no existing constraint.
--
-- WHY THE CASCADES ARE HERE AND NOT IN THE APPLICATION
--
-- Deleting a document must not leave its extracted text behind. ON DELETE
-- CASCADE on both keys makes that structural: FileAsset -> DocumentIngestion ->
-- DocumentChunk, performed by the database whether the deletion came from the
-- product, a job, or somebody with psql. Application-level cleanup would be one
-- forgotten code path away from orphaned document text.
--
-- WHAT IS NOT STORED
--
-- No storage key, bucket, endpoint, signed URL or credential. An intelligence
-- row records what a document said and how extraction went; it never records
-- where the bytes live. `errorCode` is a fixed category, never a provider
-- message, because provider messages name buckets and request ids.
--
-- SAFE ON A LIVE DATABASE
--
-- Both tables start empty and nothing reads them yet: Document Intelligence is
-- gated behind a `documentAi` flag that defaults to false and has no override
-- anywhere. This migration ships the shape; the feature stays dark.


-- CreateTable
CREATE TABLE "DocumentIngestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "fileAssetId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "pageCount" INTEGER,
    "charCount" INTEGER,
    "chunkCount" INTEGER,
    "extractorVersion" INTEGER NOT NULL DEFAULT 1,
    "errorCode" TEXT,
    "warnings" TEXT NOT NULL DEFAULT '[]',
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "DocumentIngestion_fileAssetId_workspaceId_fkey" FOREIGN KEY ("fileAssetId", "workspaceId") REFERENCES "FileAsset" ("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DocumentChunk" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "fileAssetId" TEXT NOT NULL,
    "ingestionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "pageStart" INTEGER NOT NULL,
    "pageEnd" INTEGER NOT NULL,
    "charCount" INTEGER NOT NULL,
    "tokenEstimate" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentChunk_ingestionId_fileAssetId_workspaceId_fkey" FOREIGN KEY ("ingestionId", "fileAssetId", "workspaceId") REFERENCES "DocumentIngestion" ("id", "fileAssetId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngestion_fileAssetId_key" ON "DocumentIngestion"("fileAssetId");

-- CreateIndex
CREATE INDEX "DocumentIngestion_workspaceId_status_idx" ON "DocumentIngestion"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "DocumentIngestion_status_requestedAt_idx" ON "DocumentIngestion"("status", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngestion_fileAssetId_workspaceId_key" ON "DocumentIngestion"("fileAssetId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngestion_id_fileAssetId_workspaceId_key" ON "DocumentIngestion"("id", "fileAssetId", "workspaceId");

-- CreateIndex
CREATE INDEX "DocumentChunk_workspaceId_fileAssetId_ordinal_idx" ON "DocumentChunk"("workspaceId", "fileAssetId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentChunk_ingestionId_ordinal_key" ON "DocumentChunk"("ingestionId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "FileAsset_id_workspaceId_key" ON "FileAsset"("id", "workspaceId");

