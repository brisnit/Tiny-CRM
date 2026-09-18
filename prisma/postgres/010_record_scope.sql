-- ---------------------------------------------------------------------------
-- 010 — record-level access for restricted members
--
-- The first file in which scopeMode = 'restricted' changes what someone can
-- read and write. Until now the boundary has been the workspace; this adds a
-- second one inside it, for members who were given particular work rather than
-- the whole place.
--
-- The rule, whole:
--
--   * An Opportunity or Project is visible when a RecordGrant names it.
--   * A child record is visible when EVERY anchor it names is visible.
--     A child that names no anchor is visible to nobody restricted.
--   * A Deal is never visible to a restricted member, even one whose project
--     they hold.
--
-- Why ALL and not ANY, since ANY is friendlier: a task on a granted
-- opportunity may also name an ungranted project, and its foreign key can be
-- stripped from the response while its title cannot. "Rewrite the pricing
-- section for the Meridian bid" describes work the reader was not given,
-- whatever ids travel with it. Proven case by case in
-- tests/security/record-scope.test.ts, which was committed failing first.
--
-- Nobody is restricted in production. Enforcement ships before anyone is
-- subject to it, deliberately: a boundary should be provable before it is
-- load-bearing.
--
-- ---------------------------------------------------------------------------
-- Cost
-- ---------------------------------------------------------------------------
--
-- app_is_restricted_in() reads a GUC and touches no table, and it is the first
-- operand of every predicate below. A full-workspace member — which is every
-- member today — therefore pays one string comparison per row and no index
-- probe at all. Restricted members pay one probe of
-- RecordGrant(userId, workspaceId, anchorType, anchorId) per anchor named.
--
-- Grants are read from the table rather than passed in the session, so
-- revoking one takes effect on the next statement rather than the next login.
--
-- Idempotent, like every file here.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Which workspaces restrict the current session. Set by withTenantContext
-- since Step 2; read by nothing until this file.
CREATE OR REPLACE FUNCTION app_restricted_workspace_ids() RETURNS text[]
  LANGUAGE sql STABLE
  AS $$
    SELECT CASE
      WHEN coalesce(current_setting('app.restricted_workspace_ids', true), '') = '' THEN NULL
      ELSE string_to_array(current_setting('app.restricted_workspace_ids', true), ',')
    END
  $$;

-- `x = ANY(NULL)` is NULL, which is not TRUE, so a session that declares no
-- restriction is unrestricted. That is the safe default here and only here:
-- the workspace boundary has already decided whether this row is reachable at
-- all, and this function decides whether a *narrower* rule also applies.
CREATE OR REPLACE FUNCTION app_is_restricted_in(candidate text) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT coalesce(candidate = ANY(app_restricted_workspace_ids()), false)
  $$;

-- Whether the current person may see one anchor.
CREATE OR REPLACE FUNCTION app_can_see_anchor(ws text, kind text, anchor text) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT NOT app_is_restricted_in(ws)
      OR EXISTS (
        SELECT 1 FROM "RecordGrant" g
        WHERE g."workspaceId" = ws
          AND g."userId" = app_user_id()
          AND g."anchorType" = kind
          AND g."anchorId" = anchor
      )
  $$;

-- Whether the current person may see a child that names these anchors.
--
-- ALL, with nulls ignored: every anchor the row actually names must be
-- visible, and a row naming none is visible to nobody restricted. The null
-- handling is why this is not simply two ANDs — `NULL IS NULL` is the "this
-- child does not claim that parent" case, not a wildcard.
CREATE OR REPLACE FUNCTION app_can_see_child(ws text, opp text, proj text) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT NOT app_is_restricted_in(ws)
      OR (
        (opp IS NOT NULL OR proj IS NOT NULL)
        AND (opp IS NULL OR app_can_see_anchor(ws, 'opportunity', opp))
        AND (proj IS NULL OR app_can_see_anchor(ws, 'project', proj))
      )
  $$;

-- ---------------------------------------------------------------------------
-- The anchors
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation ON "Opportunity";
CREATE POLICY tenant_isolation ON "Opportunity"
  USING (app_can_see_workspace("workspaceId") AND app_can_see_anchor("workspaceId", 'opportunity', id))
  WITH CHECK (app_can_see_workspace("workspaceId") AND app_can_see_anchor("workspaceId", 'opportunity', id));

DROP POLICY IF EXISTS tenant_isolation ON "Project";
CREATE POLICY tenant_isolation ON "Project"
  USING (app_can_see_workspace("workspaceId") AND app_can_see_anchor("workspaceId", 'project', id))
  WITH CHECK (app_can_see_workspace("workspaceId") AND app_can_see_anchor("workspaceId", 'project', id));

-- ---------------------------------------------------------------------------
-- Children that name their anchors directly
--
-- WITH CHECK is the same predicate as USING, which is what stops a child being
-- created on an anchor the author cannot see, re-parented onto one, or
-- detached into the unanchored state that nobody restricted can read.
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Task', 'Note', 'Activity', 'FileAsset'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (
          app_can_see_workspace("workspaceId")
          AND app_can_see_child("workspaceId", "opportunityId", "projectId")
        )
        WITH CHECK (
          app_can_see_workspace("workspaceId")
          AND app_can_see_child("workspaceId", "opportunityId", "projectId")
        )
    $p$, t);
  END LOOP;

  -- These two carry a project and no opportunity, so an opportunity-only grant
  -- exposes no correspondence at all. That is the intended reading of the
  -- schema rather than an omission in this file.
  FOREACH t IN ARRAY ARRAY['EmailMessage', 'CalendarEvent'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (
          app_can_see_workspace("workspaceId")
          AND app_can_see_child("workspaceId", NULL, "projectId")
        )
        WITH CHECK (
          app_can_see_workspace("workspaceId")
          AND app_can_see_child("workspaceId", NULL, "projectId")
        )
    $p$, t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Children reached through their parent
--
-- These three have no workspaceId of their own; they were already gated by an
-- EXISTS against the parent, and the parent's visibility is now the narrower
-- question.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation ON "Milestone";
CREATE POLICY tenant_isolation ON "Milestone"
  USING (
    EXISTS (
      SELECT 1 FROM "Project" p
      WHERE p.id = "projectId"
        AND app_can_see_workspace(p."workspaceId")
        AND app_can_see_anchor(p."workspaceId", 'project', p.id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Project" p
      WHERE p.id = "projectId"
        AND app_can_see_workspace(p."workspaceId")
        AND app_can_see_anchor(p."workspaceId", 'project', p.id)
    )
  );

DROP POLICY IF EXISTS tenant_isolation ON "OpportunityContact";
CREATE POLICY tenant_isolation ON "OpportunityContact"
  USING (
    EXISTS (
      SELECT 1 FROM "Opportunity" o
      WHERE o.id = "opportunityId"
        AND app_can_see_workspace(o."workspaceId")
        AND app_can_see_anchor(o."workspaceId", 'opportunity', o.id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Opportunity" o
      WHERE o.id = "opportunityId"
        AND app_can_see_workspace(o."workspaceId")
        AND app_can_see_anchor(o."workspaceId", 'opportunity', o.id)
    )
  );

DROP POLICY IF EXISTS tenant_isolation ON "ProjectContact";
CREATE POLICY tenant_isolation ON "ProjectContact"
  USING (
    EXISTS (
      SELECT 1 FROM "Project" p
      WHERE p.id = "projectId"
        AND app_can_see_workspace(p."workspaceId")
        AND app_can_see_anchor(p."workspaceId", 'project', p.id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Project" p
      WHERE p.id = "projectId"
        AND app_can_see_workspace(p."workspaceId")
        AND app_can_see_anchor(p."workspaceId", 'project', p.id)
    )
  );

-- ---------------------------------------------------------------------------
-- Deals
--
-- Not a child rule. Deals are not anchors and are not reachable through one:
-- a deal attached to a granted project stays invisible, because the decision
-- was that restricted members do not see the commercial pipeline at all.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation ON "Deal";
CREATE POLICY tenant_isolation ON "Deal"
  USING (app_can_see_workspace("workspaceId") AND NOT app_is_restricted_in("workspaceId"))
  WITH CHECK (app_can_see_workspace("workspaceId") AND NOT app_is_restricted_in("workspaceId"));

-- ---------------------------------------------------------------------------
-- Polymorphic attachments
--
-- A tag or a custom field value on an anchor is that anchor's data — the value
-- especially, since a custom field can hold anything. Rows pointing at
-- anything else keep the workspace rule they have today; contacts and
-- companies are a later step, and this file does not pre-empt it.
-- ---------------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['TagLink', 'CustomFieldValue'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (
          app_can_see_workspace("workspaceId")
          AND CASE "entityType"
                WHEN 'opportunity' THEN app_can_see_anchor("workspaceId", 'opportunity', "entityId")
                WHEN 'project' THEN app_can_see_anchor("workspaceId", 'project', "entityId")
                ELSE true
              END
        )
        WITH CHECK (
          app_can_see_workspace("workspaceId")
          AND CASE "entityType"
                WHEN 'opportunity' THEN app_can_see_anchor("workspaceId", 'opportunity', "entityId")
                WHEN 'project' THEN app_can_see_anchor("workspaceId", 'project', "entityId")
                ELSE true
              END
        )
    $p$, t);
  END LOOP;
END
$$;

COMMIT;
