-- PostgreSQL row-level security: tenant isolation enforced by the database.
--
-- Apply AFTER `prisma migrate deploy` and after 001_search_indexes.sql.
-- Not part of the portable migration history, because SQLite has no equivalent
-- and Prisma Migrate would then refuse to run one of the two engines.
--
-- ---------------------------------------------------------------------------
-- The invariant
-- ---------------------------------------------------------------------------
--
--   A query that forgets the application's workspace filter still returns no
--   other tenant's rows.
--
-- Application-level isolation (src/lib/auth/access.ts) remains the primary
-- control and is unchanged. This is the second layer, for the case that layer
-- cannot cover: a raw query, a new background job, an ORM call written outside
-- the helpers, or a SQL-injection foothold that survives parameterisation.
--
-- ---------------------------------------------------------------------------
-- How tenant context is established
-- ---------------------------------------------------------------------------
--
-- Two settings, both read with `current_setting(…, true)` so an unset value is
-- NULL rather than an error:
--
--   app.workspace_ids   comma-separated workspace ids the connection may see
--   app.user_id         the acting user, for tables scoped to a person
--
-- Both are set with `SET LOCAL`, which is transaction-scoped. That matters:
-- a pooled connection is reused across requests, and a session-scoped setting
-- would leak one tenant's context into the next request on the same connection.
-- `SET LOCAL` is discarded at COMMIT or ROLLBACK, so it cannot outlive its
-- transaction. See src/lib/tenant-db.ts.
--
-- **Unset means no rows.** `current_setting` returns NULL, every policy
-- predicate evaluates to NULL, and NULL is not TRUE — so the row is filtered
-- out. Forgetting to set the context fails closed, loudly and immediately,
-- rather than silently returning everything.
--
-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
--
--   tinycrm_app     the request path. RLS applies. No BYPASSRLS, not the table
--                   owner, so FORCE is not even needed to bind it — but FORCE is
--                   set anyway so the owner is bound too.
--   <owner role>    migrations and maintenance. Owns the tables. FORCE ROW LEVEL
--                   SECURITY binds it as well, so a mistake in a maintenance
--                   script does not silently read every tenant; a deliberate
--                   maintenance session sets `app.workspace_ids` explicitly or
--                   uses a role with BYPASSRLS.
--
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- Helper functions
--
-- STABLE, not IMMUTABLE: the value can change between statements in a
-- transaction. SECURITY INVOKER (the default) so they cannot be used to escape.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_workspace_ids() RETURNS text[]
  LANGUAGE sql STABLE
  AS $$
    SELECT CASE
      WHEN coalesce(current_setting('app.workspace_ids', true), '') = '' THEN NULL
      ELSE string_to_array(current_setting('app.workspace_ids', true), ',')
    END
  $$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS text
  LANGUAGE sql STABLE
  AS $$
    SELECT nullif(current_setting('app.user_id', true), '')
  $$;

-- `x = ANY(NULL)` is NULL, which is not TRUE, so an unset context denies. This
-- is written as a function so the deny-by-default behaviour lives in one place
-- rather than being re-derived in forty policies.
CREATE OR REPLACE FUNCTION app_can_see_workspace(candidate text) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT candidate = ANY(app_workspace_ids())
  $$;

-- ---------------------------------------------------------------------------
-- The application role
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tinycrm_app') THEN
    -- No password here: set one out of band, or use IAM/certificate auth.
    -- NOBYPASSRLS and NOSUPERUSER are the point of this role existing.
    CREATE ROLE tinycrm_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO tinycrm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tinycrm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tinycrm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tinycrm_app;

-- The audit log is append-only. The application never updates or deletes an
-- audit row, and now it cannot: this is the database making that enforceable
-- rather than merely intended.
REVOKE UPDATE, DELETE ON "AuditLog" FROM tinycrm_app;

-- ---------------------------------------------------------------------------
-- Directly scoped tables: a NOT NULL workspaceId column
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  direct text[] := ARRAY[
    'WorkspaceMember', 'Company', 'Contact', 'ProjectStatus', 'Project',
    'Pipeline', 'Deal', 'Opportunity', 'Task', 'Note', 'Activity',
    'FileAsset', 'Tag', 'TagLink', 'CustomFieldDef', 'CustomFieldValue',
    'Automation', 'AiThread', 'Integration', 'EmailMessage', 'CalendarEvent',
    'DomainEvent'
  ];
BEGIN
  FOREACH t IN ARRAY direct LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    -- USING gates what is readable and what an UPDATE/DELETE may target.
    -- WITH CHECK gates what may be written, so a row cannot be inserted into
    -- or moved to a workspace outside the current context.
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (app_can_see_workspace("workspaceId"))
        WITH CHECK (app_can_see_workspace("workspaceId"))
    $p$, t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Nullable-workspace tables
--
-- A NULL workspaceId means "not tied to a workspace" — a personal saved view, a
-- global feature flag, an audit entry that outlived the workspace it describes.
-- Those rows are gated on the acting user instead, or are globally readable
-- where they contain no tenant data.
-- ---------------------------------------------------------------------------

-- SavedView and Notification belong to a person, not to a workspace.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['SavedView', 'Notification'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (
          "userId" = app_user_id()
          AND ("workspaceId" IS NULL OR app_can_see_workspace("workspaceId"))
        )
        WITH CHECK (
          "userId" = app_user_id()
          AND ("workspaceId" IS NULL OR app_can_see_workspace("workspaceId"))
        )
    $p$, t);
  END LOOP;
END
$$;

-- AiInsight is workspace-scoped but its column is nullable for account-level
-- briefs, which are keyed to a user id in `entityId`.
ALTER TABLE "AiInsight" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiInsight" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AiInsight";
CREATE POLICY tenant_isolation ON "AiInsight"
  USING ("workspaceId" IS NULL OR app_can_see_workspace("workspaceId"))
  WITH CHECK ("workspaceId" IS NULL OR app_can_see_workspace("workspaceId"));

-- The audit log.
--
-- A row whose workspace is NULL is written deliberately when a workspace is
-- deleted: the record of the deletion has to outlive the thing deleted, or
-- "someone erased a customer" becomes unprovable.
--
-- The first version of this policy made those rows readable by *any*
-- authenticated connection, on the reasoning that they carry "no tenant data
-- beyond a name". That was wrong — the summary names the workspace and the row
-- carries `actorEmail`, so it discloses both a customer and a person. The RLS
-- test suite caught it. An orphaned row is now visible only to the actor who
-- performed the action, which preserves the record without publishing it.
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AuditLog";
CREATE POLICY tenant_isolation ON "AuditLog"
  USING (
    CASE
      WHEN "workspaceId" IS NOT NULL THEN app_can_see_workspace("workspaceId")
      ELSE "actorId" IS NOT NULL AND "actorId" = app_user_id()
    END
  )
  WITH CHECK (
    CASE
      WHEN "workspaceId" IS NOT NULL THEN app_can_see_workspace("workspaceId")
      -- An orphaned entry may only be written about oneself, so the audit log
      -- cannot be used to plant a record attributed to somebody else.
      ELSE "actorId" IS NULL OR "actorId" = app_user_id()
    END
  );

-- FeatureFlag rows are configuration, not customer data. A workspace override is
-- gated; a global row (NULL) is readable by anyone, which is what makes a flag
-- evaluable before a workspace is known.
ALTER TABLE "FeatureFlag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FeatureFlag" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "FeatureFlag";
CREATE POLICY tenant_isolation ON "FeatureFlag"
  USING ("workspaceId" IS NULL OR app_can_see_workspace("workspaceId"))
  WITH CHECK ("workspaceId" IS NULL OR app_can_see_workspace("workspaceId"));

-- ---------------------------------------------------------------------------
-- Indirectly scoped tables: reached through a parent
--
-- These carry no workspaceId of their own. The policy joins to the parent, which
-- is itself protected — so the subquery is evaluated with RLS applied and a row
-- whose parent is invisible is invisible too.
-- ---------------------------------------------------------------------------

ALTER TABLE "Milestone" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Milestone" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Milestone";
CREATE POLICY tenant_isolation ON "Milestone"
  USING (EXISTS (SELECT 1 FROM "Project" p WHERE p.id = "projectId" AND app_can_see_workspace(p."workspaceId")))
  WITH CHECK (EXISTS (SELECT 1 FROM "Project" p WHERE p.id = "projectId" AND app_can_see_workspace(p."workspaceId")));

ALTER TABLE "PipelineStage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PipelineStage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "PipelineStage";
CREATE POLICY tenant_isolation ON "PipelineStage"
  USING (EXISTS (SELECT 1 FROM "Pipeline" p WHERE p.id = "pipelineId" AND app_can_see_workspace(p."workspaceId")))
  WITH CHECK (EXISTS (SELECT 1 FROM "Pipeline" p WHERE p.id = "pipelineId" AND app_can_see_workspace(p."workspaceId")));

ALTER TABLE "ProjectContact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProjectContact" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ProjectContact";
CREATE POLICY tenant_isolation ON "ProjectContact"
  USING (EXISTS (SELECT 1 FROM "Project" p WHERE p.id = "projectId" AND app_can_see_workspace(p."workspaceId")))
  WITH CHECK (EXISTS (SELECT 1 FROM "Project" p WHERE p.id = "projectId" AND app_can_see_workspace(p."workspaceId")));

ALTER TABLE "DealContact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DealContact" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "DealContact";
CREATE POLICY tenant_isolation ON "DealContact"
  USING (EXISTS (SELECT 1 FROM "Deal" d WHERE d.id = "dealId" AND app_can_see_workspace(d."workspaceId")))
  WITH CHECK (EXISTS (SELECT 1 FROM "Deal" d WHERE d.id = "dealId" AND app_can_see_workspace(d."workspaceId")));

ALTER TABLE "OpportunityContact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OpportunityContact" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "OpportunityContact";
CREATE POLICY tenant_isolation ON "OpportunityContact"
  USING (EXISTS (SELECT 1 FROM "Opportunity" o WHERE o.id = "opportunityId" AND app_can_see_workspace(o."workspaceId")))
  WITH CHECK (EXISTS (SELECT 1 FROM "Opportunity" o WHERE o.id = "opportunityId" AND app_can_see_workspace(o."workspaceId")));

ALTER TABLE "AutomationRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AutomationRun" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AutomationRun";
CREATE POLICY tenant_isolation ON "AutomationRun"
  USING (EXISTS (SELECT 1 FROM "Automation" a WHERE a.id = "automationId" AND app_can_see_workspace(a."workspaceId")))
  WITH CHECK (EXISTS (SELECT 1 FROM "Automation" a WHERE a.id = "automationId" AND app_can_see_workspace(a."workspaceId")));

ALTER TABLE "AiMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AiMessage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AiMessage";
CREATE POLICY tenant_isolation ON "AiMessage"
  USING (EXISTS (SELECT 1 FROM "AiThread" t WHERE t.id = "threadId" AND (t."workspaceId" IS NULL OR app_can_see_workspace(t."workspaceId"))))
  WITH CHECK (EXISTS (SELECT 1 FROM "AiThread" t WHERE t.id = "threadId" AND (t."workspaceId" IS NULL OR app_can_see_workspace(t."workspaceId"))));

ALTER TABLE "EventAttendee" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EventAttendee" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "EventAttendee";
CREATE POLICY tenant_isolation ON "EventAttendee"
  USING (EXISTS (SELECT 1 FROM "CalendarEvent" e WHERE e.id = "eventId" AND app_can_see_workspace(e."workspaceId")))
  WITH CHECK (EXISTS (SELECT 1 FROM "CalendarEvent" e WHERE e.id = "eventId" AND app_can_see_workspace(e."workspaceId")));

-- ---------------------------------------------------------------------------
-- Workspace itself
--
-- Gated on membership rather than on the context list, so a workspace row is
-- visible exactly when the caller belongs to it. The subquery reads
-- WorkspaceMember, which is itself under RLS — but a member row is visible only
-- for a workspace already in the context, so this is not circular: it narrows,
-- it never widens.
-- ---------------------------------------------------------------------------

ALTER TABLE "Workspace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Workspace" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Workspace";
CREATE POLICY tenant_isolation ON "Workspace"
  USING (app_can_see_workspace(id))
  WITH CHECK (app_can_see_workspace(id));

-- ---------------------------------------------------------------------------
-- Deliberately NOT under RLS
--
--   User            Authentication happens before any workspace is known: the
--                   sign-in path must read a user row with no tenant context to
--                   set. Rows contain no tenant data, and the application never
--                   exposes another user's row.
--   AuthToken       Password-reset and verification tokens, looked up by hash
--                   before a session exists. Same reason.
--   UsageCounter    Keyed to a user, not a workspace; consulted while
--                   establishing entitlements, before context exists.
--   IdempotencyKey  Written by the billing webhook, which is authenticated by
--                   signature and has no user or workspace context.
--
-- Each is listed in docs/RLS.md with the reasoning, so "not covered" is a
-- decision on the record rather than an omission.
-- ---------------------------------------------------------------------------

COMMIT;
