-- ---------------------------------------------------------------------------
-- 009 — RecordGrant joins the tenant boundary
--
-- A new table that carries a workspaceId is a new place for a tenant to leak,
-- and the hosted verification counts workspace tables without a policy. So the
-- table gets one in the same change that creates it, rather than in the change
-- that starts using it.
--
-- This policy is the ordinary workspace rule — the same one twenty-four other
-- tables use. It is deliberately not the final one:
--
--   * Nothing reads this table yet. Record-level access is not enforced until
--     the step that adds its policies, and no membership can be set to
--     "restricted" before then.
--   * When it is enforced, a grant is consulted by a helper running as the
--     reader, so a person must be able to see their own grants. Whether a
--     restricted member should also see *other* members' grants in their
--     workspace — which would disclose that work exists without disclosing the
--     work — is a question for the step that builds the screen answering
--     "who can reach this record?". Narrowing it here, before that screen
--     exists, would be guessing at the shape of something unbuilt.
--
-- Idempotent, like every file here.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE "RecordGrant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RecordGrant" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "RecordGrant";
CREATE POLICY tenant_isolation ON "RecordGrant"
  USING (app_can_see_workspace("workspaceId"))
  WITH CHECK (app_can_see_workspace("workspaceId"));

COMMIT;
