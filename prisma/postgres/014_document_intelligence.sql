-- ---------------------------------------------------------------------------
-- Document Intelligence: row-level security
--
-- Extracted document text is the most sensitive thing this product stores. A
-- contact row leaks a name; a chunk row leaks whatever was inside somebody's
-- contract. So these two tables get the same treatment as everything else, and
-- the boundary is derived from the document rather than restated.
--
-- THE RULE
--
--   You may read a document's intelligence exactly when you may read the
--   document.
--
-- Not "when you are in the same workspace". FileAsset is already subject to two
-- rules — the workspace policy from 002 and the restricted-member record scope
-- from 010 — and a restricted member who was never granted a project cannot see
-- files attached to it. If these tables only checked the workspace, extracted
-- text would be readable by someone who cannot open the PDF it came from, which
-- is a worse leak than the one the record scope was built to prevent.
--
-- WHY THE PREDICATE IS SPELLED OUT RATHER THAN DELEGATED
--
-- The obvious version is `EXISTS (SELECT 1 FROM "FileAsset" WHERE id = ...)`
-- and trusting FileAsset's own policy to filter the subquery. This file does
-- not do that. It re-derives FileAsset's predicate from FileAsset's columns,
-- exactly as 010_record_scope.sql does for Milestone, ProjectContact and
-- OpportunityContact. Two reasons: it is the established convention here, and
-- it does not depend on a reading of when PostgreSQL applies a referenced
-- table's policies inside a policy expression. The predicate is stated where it
-- is enforced.
--
-- WHY A KNOWN ID IS NOT A SHORTCUT
--
-- Neither policy looks at the row's own `workspaceId` alone. Knowing a chunk id
-- gets an attacker a lookup by primary key, and that lookup still has to
-- satisfy an EXISTS against the file. There is no id-shaped way in.
--
-- The `workspaceId` equality in each EXISTS is not redundant with the foreign
-- key. The FK makes the columns agree; this makes the policy say which of them
-- it is trusting, so the predicate remains correct if the FK is ever relaxed.
-- ---------------------------------------------------------------------------

ALTER TABLE "DocumentIngestion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentIngestion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DocumentIngestion";
CREATE POLICY tenant_isolation ON "DocumentIngestion"
  USING (
    EXISTS (
      SELECT 1 FROM "FileAsset" f
      WHERE f.id = "fileAssetId"
        AND f."workspaceId" = "workspaceId"
        AND app_can_see_workspace(f."workspaceId")
        AND app_can_see_child(f."workspaceId", f."opportunityId", f."projectId")
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "FileAsset" f
      WHERE f.id = "fileAssetId"
        AND f."workspaceId" = "workspaceId"
        AND app_can_see_workspace(f."workspaceId")
        AND app_can_see_child(f."workspaceId", f."opportunityId", f."projectId")
    )
  );

ALTER TABLE "DocumentChunk" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DocumentChunk" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DocumentChunk";
CREATE POLICY tenant_isolation ON "DocumentChunk"
  USING (
    EXISTS (
      SELECT 1 FROM "FileAsset" f
      WHERE f.id = "fileAssetId"
        AND f."workspaceId" = "workspaceId"
        AND app_can_see_workspace(f."workspaceId")
        AND app_can_see_child(f."workspaceId", f."opportunityId", f."projectId")
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "FileAsset" f
      WHERE f.id = "fileAssetId"
        AND f."workspaceId" = "workspaceId"
        AND app_can_see_workspace(f."workspaceId")
        AND app_can_see_child(f."workspaceId", f."opportunityId", f."projectId")
    )
  );

-- The default privileges in 002 cover tables created by the same owner, but
-- stating it here means this file can be applied to a database where that
-- default was never in force.
GRANT SELECT, INSERT, UPDATE, DELETE ON "DocumentIngestion" TO tinycrm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "DocumentChunk" TO tinycrm_app;
