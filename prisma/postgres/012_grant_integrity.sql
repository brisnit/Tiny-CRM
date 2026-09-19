-- ---------------------------------------------------------------------------
-- 012 — the grant table defends itself
--
-- Steps 3A and 3B put record-level visibility in the database, where it cannot
-- be forgotten. The table those rules read has been protected by the ordinary
-- workspace policy alone, which means the boundary has rested on one server
-- action remembering to check `members:manage`. Every other rule here is
-- enforced by PostgreSQL; this one was not.
--
-- Two changes, and they answer two different questions.
--
--   1. WHO MAY WRITE A GRANT. A restricted member's own session satisfies
--      `app_can_see_workspace`, so nothing at the database stopped them
--      inserting a grant naming work they cannot see. Now a write must come
--      from somebody who may administer members — or from the invitee of a live
--      invitation that names exactly this anchor, which is the one case where a
--      person legitimately creates their own grant.
--
--   2. WHO MAY READ A GRANT. 009 left this open deliberately, for "the step
--      that builds the screen answering 'who can reach this record?'". This is
--      that step. A restricted member reading the whole table learns the ids of
--      work behind the boundary and which colleague holds each — the roster D5
--      keeps private, plus an index of what is being withheld. They now see
--      their own grants and nobody else's; an administrator still sees all of
--      them, because that screen is the reason the table is shaped this way.
--
-- Nobody is restricted in production when this ships. As with 010 and 011, the
-- rule arrives before anyone is subject to it.
--
-- ---------------------------------------------------------------------------
-- Why the invitation arm parses JSON
-- ---------------------------------------------------------------------------
--
-- Materializing an invitation's anchors happens inside the invitee's own
-- transaction: they are authenticated, the workspace is in their context, and
-- they are not yet restricted. That is the only moment a person writes their
-- own grants, and the application decides which anchors on the strength of the
-- stored invitation. This policy checks the same thing independently, the way
-- `member_bootstrap_self_only` re-checks the invitation behind the membership
-- INSERT rather than taking the application's word for it.
--
-- The scope payload is a text column holding JSON — the portability contract
-- forbids a json column — so the check has to parse it. A malformed payload
-- raises, and a raise inside a policy would abort the statement rather than
-- deny the row; worse, it could abort a statement that had nothing to do with
-- that invitation. So the parse lives in a plpgsql function with an exception
-- handler that returns false. Unparseable scope grants nothing, and it does so
-- quietly, which is the fail-closed reading.
--
-- Idempotent, like every file here.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- Does a live invitation for this person name this anchor?
-- ---------------------------------------------------------------------------
--
-- Every condition earns its place. The address join means an invitation to one
-- inbox cannot materialize grants for another account. The three null/expiry
-- checks mean a revoked, already-claimed or expired invitation grants nothing —
-- the same four conditions the membership policy uses, so both halves of an
-- acceptance are admitted by the same evidence. And the scope entry must match
-- this grant's anchor type *and* id, so an invitation to one opportunity cannot
-- be stretched into a grant for another.
CREATE OR REPLACE FUNCTION app_invitation_names_anchor(
  ws text, member_user text, kind text, anchor text
) RETURNS boolean
  LANGUAGE plpgsql STABLE
  AS $$
  BEGIN
    RETURN EXISTS (
      SELECT 1
      FROM "WorkspaceInvitation" i
      JOIN "User" u ON u.id = member_user
      CROSS JOIN LATERAL jsonb_array_elements(i.scope::jsonb) entry
      WHERE i."workspaceId" = ws
        AND lower(i.email) = lower(u.email)
        AND i."scopeMode" = 'restricted'
        AND i."acceptedAt" IS NULL
        AND i."revokedAt" IS NULL
        AND i."expiresAt" > now()
        AND entry->>'entityType' = kind
        AND entry->>'entityId' = anchor
    );
  EXCEPTION
    -- A scope payload that is not a JSON array names nothing.
    WHEN others THEN RETURN false;
  END
  $$;

-- Whether the current session may administer members here.
--
-- Two conditions, and the second is the one that matters: a restricted admin is
-- a coherent state, and restriction has to bind them too. Otherwise the person
-- confined to three opportunities could hand themselves a fourth.
CREATE OR REPLACE FUNCTION app_may_administer_members(ws text) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM "WorkspaceMember" m
      WHERE m."workspaceId" = ws
        AND m."userId" = app_user_id()
        AND m.role IN ('owner', 'admin')
        AND m."scopeMode" = 'workspace'
    )
  $$;

-- ---------------------------------------------------------------------------
-- Who may write a grant
-- ---------------------------------------------------------------------------
--
-- RESTRICTIVE, so each is ANDed with the workspace policy rather than ORed:
-- these can only ever narrow what is permitted. The workspace rule still
-- decides whether the row is in reach at all; these decide whether this session
-- is entitled to write it.
--
-- One policy per writing command rather than a single FOR ALL. A restrictive
-- FOR ALL would also govern SELECT, and reading is already handled below — a
-- blanket rule would additionally stop an ordinary full-workspace member from
-- reading the table, which nothing in this step calls for and which
-- `app_can_see_anchor` depends on, since RLS applies inside policy subqueries.
DROP POLICY IF EXISTS grant_written_by_administrator ON "RecordGrant";
DROP POLICY IF EXISTS grant_insert_authorised ON "RecordGrant";
CREATE POLICY grant_insert_authorised ON "RecordGrant"
  AS RESTRICTIVE
  FOR INSERT
  WITH CHECK (
    app_may_administer_members("workspaceId")
    OR (
      -- The invitee, materializing exactly what their live invitation names.
      -- This is the only case in which a person creates their own grant.
      "userId" = app_user_id()
      AND app_invitation_names_anchor("workspaceId", "userId", "anchorType", "anchorId")
    )
  );

-- A grant is created and destroyed, never edited: there is no field on it that
-- means anything to change. Updating one is refused outright.
DROP POLICY IF EXISTS grant_update_authorised ON "RecordGrant";
CREATE POLICY grant_update_authorised ON "RecordGrant"
  AS RESTRICTIVE
  FOR UPDATE
  USING (false)
  WITH CHECK (false);

-- Removal is administration, like creation. A membership being deleted takes
-- its grants with it through the foreign key, and referential actions bypass
-- row security by design, so the cascade does not need an arm here.
DROP POLICY IF EXISTS grant_delete_authorised ON "RecordGrant";
CREATE POLICY grant_delete_authorised ON "RecordGrant"
  AS RESTRICTIVE
  FOR DELETE
  USING (app_may_administer_members("workspaceId"));

-- ---------------------------------------------------------------------------
-- Who may read a grant
-- ---------------------------------------------------------------------------
--
-- Replaces 009's plain workspace rule. Unrestricted members are unchanged —
-- the audit direction, "who can reach this record?", still works. A restricted
-- member sees only rows naming themselves.
DROP POLICY IF EXISTS tenant_isolation ON "RecordGrant";
CREATE POLICY tenant_isolation ON "RecordGrant"
  USING (
    app_can_see_workspace("workspaceId")
    AND (NOT app_is_restricted_in("workspaceId") OR "userId" = app_user_id())
  )
  WITH CHECK (
    app_can_see_workspace("workspaceId")
    AND (NOT app_is_restricted_in("workspaceId") OR "userId" = app_user_id())
  );

COMMIT;
