-- ---------------------------------------------------------------------------
-- 007 — an AI thread that belongs to a person rather than to a workspace
-- ---------------------------------------------------------------------------
--
-- `AiThread.workspaceId` is nullable on purpose: a question asked with the
-- workspace switcher on "All businesses" belongs to the account, not to any one
-- workspace, and `ensureThread(userId, null)` is the path that creates it.
--
-- 002 put AiThread in the directly-scoped list, whose policy is
--
--     USING (app_can_see_workspace("workspaceId"))
--
-- and `app_can_see_workspace(NULL)` is `NULL = ANY(...)`, which is NULL, which
-- is not TRUE. So the row was invisible and the insert was refused, and because
-- SQLite has no policies at all, every local test passed while the hosted
-- application could not open an account-level conversation.
--
-- That this was an oversight rather than a decision is visible in 002 itself:
-- the policy on `AiMessage`, written at the same time, already tolerates the
-- parent this one refuses to be —
--
--     EXISTS (SELECT 1 FROM "AiThread" t WHERE t.id = "threadId"
--             AND (t."workspaceId" IS NULL OR app_can_see_workspace(t."workspaceId")))
--
-- The shape below is the one 002 already uses for the other nullable-workspace
-- tables (`AuditLog`, `SecurityAlert`): scoped by workspace when it has one,
-- and by the person when it does not. A thread with no workspace is therefore
-- visible to exactly one person — its owner — and to no one else, in any
-- workspace.
--
-- Idempotent, like every file here: it drops and recreates the policy.
--
-- Proven in tests/security/workspaceless-and-system-actor.test.ts, which failed
-- against this table before this file existed.
-- ---------------------------------------------------------------------------

ALTER TABLE "AiThread" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiThread" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AiThread";
CREATE POLICY tenant_isolation ON "AiThread"
  USING (
    CASE
      WHEN "workspaceId" IS NOT NULL THEN app_can_see_workspace("workspaceId")
      ELSE "userId" = app_user_id()
    END
  )
  WITH CHECK (
    CASE
      WHEN "workspaceId" IS NOT NULL THEN app_can_see_workspace("workspaceId")
      ELSE "userId" = app_user_id()
    END
  );
