-- ---------------------------------------------------------------------------
-- Workspace bootstrap
--
-- Creating a workspace is the one write that cannot satisfy the ordinary rule.
-- Every other policy asks "does this row belong to a workspace in my context?",
-- and a workspace being created is in nobody's memberships yet.
--
-- The application solves that by generating the id first and provisioning
-- inside a tenant context containing it (src/lib/workspaces/provision.ts), so
-- the INSERT passes the existing `tenant_isolation` policy unchanged. Nothing
-- here loosens that policy.
--
-- What this file adds is the database's own guarantee, so the rule does not
-- depend on the application getting the context right: a RESTRICTIVE policy.
-- Restrictive policies are ANDed with the permissive ones rather than ORed, so
-- this can only ever narrow what is permitted.
--
--   permissive (existing):  the workspace id is in my context
--   restrictive (this):     AND I am the owner of the row being inserted
--
-- Net effect: an authenticated caller may create a workspace only if they own
-- it. A caller who somehow influenced the tenant context still cannot create a
-- workspace owned by somebody else, and cannot create one at all without an
-- authenticated user id in context.
--
-- Idempotent: safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

DROP POLICY IF EXISTS workspace_bootstrap_owner_only ON "Workspace";
CREATE POLICY workspace_bootstrap_owner_only ON "Workspace"
  AS RESTRICTIVE
  FOR INSERT
  WITH CHECK ("ownerId" IS NOT NULL AND "ownerId" = app_user_id());

-- The first membership is created in the same statement graph as the workspace
-- and is covered by the workspace's own context. This restrictive policy makes
-- the intent explicit at the database: the row that grants access to a brand-new
-- workspace may only ever grant it to the person creating it.
--
-- There are exactly three ways a membership row may legitimately appear, and
-- each is an arm of the check below:
--
--   1. An existing member adds someone. The application has already checked
--      `members:manage`; the database only needs to know the actor belongs here.
--   2. The bootstrap row, granting the creator access to the workspace they own.
--   3. **Someone accepting an invitation addressed to them.** This arm was
--      missing, and without it the whole invite flow is refused by the database:
--      an invitee is by definition not yet a member (arm 1 fails) and does not
--      own the workspace (arm 2 fails). The fix is not to trust the application
--      instead — it is to let the database check the invitation itself, which it
--      can do completely: a live, unexpired, unaccepted, unrevoked invitation
--      addressed to this user's own email address, granting membership to that
--      same user and nobody else.
DROP POLICY IF EXISTS member_bootstrap_self_only ON "WorkspaceMember";
CREATE POLICY member_bootstrap_self_only ON "WorkspaceMember"
  AS RESTRICTIVE
  FOR INSERT
  WITH CHECK (
    -- Either the actor already belongs to this workspace (a normal invitation,
    -- authorised by the application's permission check) …
    EXISTS (
      SELECT 1 FROM "WorkspaceMember" existing
      WHERE existing."workspaceId" = "WorkspaceMember"."workspaceId"
        AND existing."userId" = app_user_id()
    )
    -- … or this is the bootstrap row, granting the creator access to the
    -- workspace they own …
    OR (
      "userId" = app_user_id()
      AND EXISTS (
        SELECT 1 FROM "Workspace" w
        WHERE w.id = "WorkspaceMember"."workspaceId"
          AND w."ownerId" = app_user_id()
      )
    )
    -- … or this user is accepting a live invitation addressed to them.
    --
    -- Every condition matters. `"userId" = app_user_id()` means a token can only
    -- ever add the person holding it, never a third party. The email join means
    -- an invitation to one address cannot be redeemed by another account. The
    -- three null/expiry checks mean a revoked, already-accepted or expired row
    -- grants nothing, so the database reaches the same verdict as the
    -- application rather than taking its word for it.
    OR (
      "userId" = app_user_id()
      AND EXISTS (
        SELECT 1
        FROM "WorkspaceInvitation" i
        JOIN "User" u ON u.id = "WorkspaceMember"."userId"
        WHERE i."workspaceId" = "WorkspaceMember"."workspaceId"
          AND lower(i.email) = lower(u.email)
          AND i."acceptedAt" IS NULL
          AND i."revokedAt" IS NULL
          AND i."expiresAt" > now()
      )
    )
  );

COMMIT;
