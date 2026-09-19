-- A grant belongs to a membership, not to a person.
--
-- RecordGrant gains `membershipId` and points at WorkspaceMember through all
-- three identity columns at once, so the row cannot name one membership while
-- its userId and workspaceId name somebody else. ON DELETE CASCADE means
-- removing a member destroys their grants in the database, not merely in the
-- server action that happens to remember to.
--
-- The table is empty in every environment: no product path has ever written to
-- it, and production holds zero rows. Any row that did exist could not be
-- migrated, because nothing in it names a membership — so the rebuild starts
-- from empty rather than failing halfway.
DELETE FROM "RecordGrant";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_RecordGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "anchorType" TEXT NOT NULL,
    "anchorId" TEXT NOT NULL,
    "grantedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecordGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RecordGrant_membershipId_workspaceId_userId_fkey" FOREIGN KEY ("membershipId", "workspaceId", "userId") REFERENCES "WorkspaceMember" ("id", "workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_RecordGrant" ("anchorId", "anchorType", "createdAt", "grantedById", "id", "userId", "workspaceId", "membershipId") SELECT "anchorId", "anchorType", "createdAt", "grantedById", "id", "userId", "workspaceId", '' FROM "RecordGrant";
DROP TABLE "RecordGrant";
ALTER TABLE "new_RecordGrant" RENAME TO "RecordGrant";
CREATE INDEX "RecordGrant_membershipId_idx" ON "RecordGrant"("membershipId");
CREATE INDEX "RecordGrant_userId_workspaceId_anchorType_anchorId_idx" ON "RecordGrant"("userId", "workspaceId", "anchorType", "anchorId");
CREATE INDEX "RecordGrant_workspaceId_anchorType_anchorId_idx" ON "RecordGrant"("workspaceId", "anchorType", "anchorId");
CREATE UNIQUE INDEX "RecordGrant_workspaceId_userId_anchorType_anchorId_key" ON "RecordGrant"("workspaceId", "userId", "anchorType", "anchorId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
-- Not redundant with the primary key: a composite foreign key must reference a
-- uniquely-constrained set of columns, and this is the set RecordGrant names.
CREATE UNIQUE INDEX "WorkspaceMember_id_workspaceId_userId_key" ON "WorkspaceMember"("id", "workspaceId", "userId");
