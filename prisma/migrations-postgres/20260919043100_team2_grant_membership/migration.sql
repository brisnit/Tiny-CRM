-- A grant belongs to a membership, not to a person.
--
-- RecordGrant gains `membershipId` and references WorkspaceMember through all
-- three identity columns at once, so a row cannot name one membership while its
-- userId and workspaceId name somebody else. ON DELETE CASCADE means removing a
-- member destroys their grants in the database, not merely in the server action
-- that happens to remember to.
--
-- The table is empty in every environment: no product path has ever written to
-- it, and production holds zero rows. A row that did exist could not be
-- migrated, because nothing in it names a membership — so the column is added
-- to an empty table rather than backfilled with a guess.
DELETE FROM "RecordGrant";

-- AlterTable
ALTER TABLE "RecordGrant" ADD COLUMN     "membershipId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "RecordGrant_membershipId_idx" ON "RecordGrant"("membershipId");

-- CreateIndex
-- Not redundant with the primary key: a composite foreign key must reference a
-- uniquely-constrained set of columns, and this is the set RecordGrant names.
CREATE UNIQUE INDEX "WorkspaceMember_id_workspaceId_userId_key" ON "WorkspaceMember"("id", "workspaceId", "userId");

-- AddForeignKey
-- DEFERRABLE from birth, so the restore path stays whole without waiting for
-- 003_deferrable_constraints.sql to sweep it up. INITIALLY IMMEDIATE, so normal
-- operation is unchanged: a dangling reference still fails on the statement
-- that writes it.
ALTER TABLE "RecordGrant" ADD CONSTRAINT "RecordGrant_membershipId_workspaceId_userId_fkey" FOREIGN KEY ("membershipId", "workspaceId", "userId") REFERENCES "WorkspaceMember"("id", "workspaceId", "userId") ON DELETE CASCADE ON UPDATE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
