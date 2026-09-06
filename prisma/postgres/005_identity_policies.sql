-- ---------------------------------------------------------------------------
-- Identity policies: how a request learns what it is allowed to see
--
-- The tenant context is a list of workspace ids, and the application derives it
-- from the caller's memberships. But `WorkspaceMember` and `Workspace` were
-- themselves only visible to a request that already had a context — so the
-- lookup that produces the context was denied by the context it was trying to
-- produce. The application saw zero memberships for every user, every workspace
-- check failed with "not found", and the isolation tests still passed, because
-- an attack that is refused looks identical to an application that cannot read
-- anything at all.
--
-- The fix is not to relax tenancy. It is to state the one rule that does not
-- depend on a context, and cannot: **you may always see your own membership,
-- and the workspaces it grants you.** That is the ground truth the context is
-- built from.
--
-- These are PERMISSIVE policies, so they are ORed with `tenant_isolation`. They
-- widen visibility only to rows that name the authenticated user, and only for
-- SELECT — no write path is affected, and the restrictive bootstrap policies in
-- 004 continue to apply to every INSERT.
--
-- Recursion: the Workspace policy sub-queries WorkspaceMember, whose own
-- policies are then evaluated. The membership policy below is a plain column
-- comparison with no sub-query, so evaluation terminates. Deliberately not a
-- SECURITY DEFINER function, which would run as the table owner and, on a
-- provider whose owner carries BYPASSRLS, would silently hand back every row.
--
-- Idempotent: safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- A user can always read their own membership rows. Without this, nothing can
-- bootstrap: not the session, not the workspace switcher, not authorisation.
DROP POLICY IF EXISTS member_sees_own_membership ON "WorkspaceMember";
CREATE POLICY member_sees_own_membership ON "WorkspaceMember"
  FOR SELECT
  USING ("userId" IS NOT NULL AND "userId" = app_user_id());

-- A user can read a workspace they are a member of, whether or not it is in the
-- current context. This is what makes the workspace switcher and the "which
-- workspaces do I belong to" lookup work, and it is strictly narrower than the
-- membership rule above — it grants nothing that the membership row does not
-- already prove.
DROP POLICY IF EXISTS workspace_visible_to_members ON "Workspace";
CREATE POLICY workspace_visible_to_members ON "Workspace"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "WorkspaceMember" m
      WHERE m."workspaceId" = "Workspace".id
        AND m."userId" = app_user_id()
    )
  );

COMMIT;
