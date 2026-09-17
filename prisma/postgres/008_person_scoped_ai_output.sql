-- ---------------------------------------------------------------------------
-- 008 — AI output belongs to the person it was generated for
--
-- Three tables held text assembled for one person and readable by every member
-- of their workspace:
--
--   AiInsight (kind = 'brief')  the daily brief, written from a sweep of the
--                               highest-value and most urgent records in the
--                               workspace. Access was decided by the row's
--                               workspaceId; who it belonged to lived only in a
--                               composed entityId string, which the database
--                               never read.
--   AiThread                    007 person-gated the account-level case and
--                               left workspace-bound threads on the workspace
--                               rule, so a colleague could read the questions
--                               someone asked.
--   AiMessage                   reachable through its thread, and so exposed
--                               with it — the message rows hold the full
--                               question and the full answer.
--
-- The dangerous direction is proven first, in
-- tests/security/person-scoped-ai-output.test.ts: seven of its assertions fail
-- against the policies this file replaces, including one that reads briefs with
-- no identity in context at all.
--
-- What this file deliberately does NOT do: kind = 'summary' insights stay
-- shared with the workspace. A summary is derived from a single record's own
-- notes and activity, and everyone who can open that record is meant to see it.
-- Its eventual visibility belongs with record-level access, where it can follow
-- the record rather than the workspace.
--
-- Idempotent, like every file here: it drops and recreates each policy.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- AiInsight
--
-- A brief is its owner's. Everything else keeps the workspace rule it had.
-- Written as CASE rather than OR so that a future kind cannot fall through into
-- the shared branch by accident: the person-owned branch is chosen by kind, and
-- every other kind is named by the ELSE.
-- ---------------------------------------------------------------------------

ALTER TABLE "AiInsight" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiInsight" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AiInsight";
CREATE POLICY tenant_isolation ON "AiInsight"
  USING (
    CASE
      WHEN "kind" = 'brief' THEN
        "userId" IS NOT NULL
        AND "userId" = app_user_id()
        AND ("workspaceId" IS NULL OR app_can_see_workspace("workspaceId"))
      ELSE ("workspaceId" IS NULL OR app_can_see_workspace("workspaceId"))
    END
  )
  WITH CHECK (
    CASE
      WHEN "kind" = 'brief' THEN
        "userId" IS NOT NULL
        AND "userId" = app_user_id()
        AND ("workspaceId" IS NULL OR app_can_see_workspace("workspaceId"))
      ELSE ("workspaceId" IS NULL OR app_can_see_workspace("workspaceId"))
    END
  );

-- ---------------------------------------------------------------------------
-- AiThread
--
-- Replaces the 007 policy. The account-level rule it established is unchanged;
-- the workspace-bound case now asks the same question. A thread still cannot
-- escape its workspace, so both conditions apply rather than either.
-- ---------------------------------------------------------------------------

ALTER TABLE "AiThread" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiThread" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AiThread";
CREATE POLICY tenant_isolation ON "AiThread"
  USING (
    "userId" = app_user_id()
    AND ("workspaceId" IS NULL OR app_can_see_workspace("workspaceId"))
  )
  WITH CHECK (
    "userId" = app_user_id()
    AND ("workspaceId" IS NULL OR app_can_see_workspace("workspaceId"))
  );

-- ---------------------------------------------------------------------------
-- AiMessage
--
-- Gated through the parent thread, and on the thread's userId rather than the
-- message's own: assistant rows are written with no userId, so a check against
-- the message would refuse the half of the conversation that matters most.
-- The workspace condition is spelled out here rather than left to the parent's
-- own policy, matching the other parent-reached tables in 002 — inherited RLS
-- inside a policy subquery is a semantic worth not depending on.
-- ---------------------------------------------------------------------------

ALTER TABLE "AiMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiMessage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AiMessage";
CREATE POLICY tenant_isolation ON "AiMessage"
  USING (
    EXISTS (
      SELECT 1 FROM "AiThread" t
      WHERE t.id = "threadId"
        AND t."userId" = app_user_id()
        AND (t."workspaceId" IS NULL OR app_can_see_workspace(t."workspaceId"))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "AiThread" t
      WHERE t.id = "threadId"
        AND t."userId" = app_user_id()
        AND (t."workspaceId" IS NULL OR app_can_see_workspace(t."workspaceId"))
    )
  );

COMMIT;
