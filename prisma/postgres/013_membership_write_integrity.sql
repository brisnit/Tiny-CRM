-- ---------------------------------------------------------------------------
-- 013 — a membership may only be rewritten by somebody entitled to
--
-- `WorkspaceMember` is where authority lives: the role a person holds and the
-- scope they hold it in. Every other policy in this directory reads it.
-- Until now it defended one command.
--
-- 004 added `member_bootstrap_self_only`, RESTRICTIVE, FOR INSERT. Nothing
-- governed UPDATE or DELETE, so those fell to the permissive workspace rule
-- alone — and that rule asks only "is this row in a workspace I belong to?".
-- The answer for a member looking at its own workspace is yes, for every row
-- in it. A session could therefore lift its own restriction, promote itself to
-- owner, confine the workspace's owner, rewrite a colleague's role, or delete
-- a membership outright.
--
-- The INSERT arm was not much narrower. Its first arm admits "the actor
-- already belongs to this workspace", which is not the same question as "may
-- the actor administer members" — and the gap between those two is a member
-- minting an owner membership for an accomplice.
--
-- None of this is reachable through the product. Every membership write goes
-- through changeMemberRole, removeMember or setMemberScope, each requiring
-- `members:manage`, each enforcing owner safety, and each refusing a
-- restricted actor since Step 4. It is reachable by anything that can execute
-- a statement as `tinycrm_app` with a session context, which is exactly the
-- threat model 002 onwards is written against. The gap predates Team-2; it was
-- found by the canary harness, before the canary was ever run.
--
-- Proven failing first, in tests/security/membership-write-integrity.test.ts.
--
-- ---------------------------------------------------------------------------
-- What this changes, and what it deliberately does not
-- ---------------------------------------------------------------------------
--
--   * SELECT is untouched. `tenant_isolation` and `member_sees_own_membership`
--     stay exactly as they are. A person must be able to read their own
--     membership — the whole request path derives their scope from it — and
--     narrowing reads is a different question from narrowing writes.
--
--   * Owner safety stays in the application. "A workspace must always have one
--     owner" is an availability rule needing a count across rows, and a row
--     policy is the wrong instrument for it. changeMemberRole and removeMember
--     continue to enforce it.
--
--   * One policy per writing command rather than a single FOR ALL, so nothing
--     here can quietly change what SELECT does.
--
-- ---------------------------------------------------------------------------
-- On reusing app_may_administer_members()
-- ---------------------------------------------------------------------------
--
-- 012 introduced it for the grant table and its semantics are exactly right
-- here too: owner or admin, in this workspace, and full-workspace rather than
-- restricted. A restricted administrator is a coherent state — role and scope
-- are orthogonal — and restriction has to bind them, or the person confined to
-- three opportunities could simply promote themselves out of it.
--
-- It reads `WorkspaceMember` while guarding `WorkspaceMember`, which looks like
-- policy recursion and is not: the inner read is governed by that table's
-- SELECT policies, and those consult GUCs rather than the table, so nothing
-- re-enters. Checked on a real cluster rather than reasoned about — the
-- alternative was a SECURITY DEFINER helper, which would have been a larger
-- and more privileged thing to introduce for no gain.
--
-- Note for whoever reads this next: the database is now stricter than the
-- application for two paths. changeMemberRole and removeMember do not yet
-- refuse a restricted administrator, so one could call them and see zero rows
-- change while being told it worked. No restricted member exists anywhere
-- today, so there is nothing to break; aligning the application is a separate,
-- deliberate change rather than something to smuggle into a policy file.
--
-- Idempotent, like every file here.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- INSERT — replaces 004's arm 1 with the question it meant to ask
-- ---------------------------------------------------------------------------
--
-- Arms 2 and 3 are unchanged from 004 and carry their reasoning with them.
-- Arm 1 becomes an administration check instead of a membership check.
--
-- Arm 3 additionally pins the role and scope to what the invitation actually
-- offered. Without that, holding a live invitation as a `member` admitted a
-- row claiming `owner`: the database was checking that somebody was invited,
-- not what they were invited as.
DROP POLICY IF EXISTS member_bootstrap_self_only ON "WorkspaceMember";
CREATE POLICY member_bootstrap_self_only ON "WorkspaceMember"
  AS RESTRICTIVE
  FOR INSERT
  WITH CHECK (
    -- An administrator of this workspace is adding somebody.
    app_may_administer_members("workspaceId")
    -- … or this is the bootstrap row, granting the creator access to the
    -- workspace they own.
    OR (
      "userId" = app_user_id()
      AND EXISTS (
        SELECT 1 FROM "Workspace" w
        WHERE w.id = "WorkspaceMember"."workspaceId"
          AND w."ownerId" = app_user_id()
      )
    )
    -- … or this user is accepting a live invitation addressed to them, on the
    -- terms it was issued on.
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
          AND i.role = "WorkspaceMember".role
          AND i."scopeMode" = "WorkspaceMember"."scopeMode"
      )
    )
  );

-- ---------------------------------------------------------------------------
-- UPDATE — administration, on both sides of the edit
-- ---------------------------------------------------------------------------
--
-- USING governs the row as it stands, WITH CHECK the row as it would become.
-- Both are needed: USING alone would let an administrator of workspace A move
-- a membership into workspace B, where they may have no standing at all.
DROP POLICY IF EXISTS member_update_authorised ON "WorkspaceMember";
CREATE POLICY member_update_authorised ON "WorkspaceMember"
  AS RESTRICTIVE
  FOR UPDATE
  USING (app_may_administer_members("workspaceId"))
  WITH CHECK (app_may_administer_members("workspaceId"));

-- ---------------------------------------------------------------------------
-- DELETE — the same standing that creation requires
-- ---------------------------------------------------------------------------
--
-- Removing a membership ends somebody's access to everything in the workspace,
-- so it asks for the same authority as granting it. A workspace being deleted
-- still takes its memberships with it: referential actions bypass row security
-- by design, so the cascade needs no arm here.
DROP POLICY IF EXISTS member_delete_authorised ON "WorkspaceMember";
CREATE POLICY member_delete_authorised ON "WorkspaceMember"
  AS RESTRICTIVE
  FOR DELETE
  USING (app_may_administer_members("workspaceId"));

COMMIT;
