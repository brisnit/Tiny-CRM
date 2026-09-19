-- ---------------------------------------------------------------------------
-- 011 — contacts and companies, for restricted members
--
-- 010 confined restricted members to their anchors and left these two tables on
-- the workspace rule, saying so in its own comment. This is that deferral paid
-- off: a contact is reachable only through work the member holds, and a company
-- only through work that names it.
--
--   Contact  visible when an OpportunityContact or ProjectContact row connects
--            it to a visible anchor. Being the primary contact of a visible
--            company is deliberately NOT a connection: the company is visible
--            as identity, and identity does not hand over a person.
--
--   Company  visible when a visible Opportunity or Project names it.
--
-- Row visibility is only half of the company rule. RLS can decide whether the
-- row exists; it cannot turn a full record into an identity-only one, so the
-- eight-field projection lives in the data layer and is pinned by a test that
-- enumerates Company's columns from the Prisma schema. That split is deliberate
-- and documented rather than implied.
--
-- Deals stay denied. The polymorphic attachments gain contact and company arms,
-- so a tag or a custom field value cannot describe a record its subject cannot
-- see.
--
-- Proven by tests/security/contact-company-scope.test.ts, committed failing
-- first: twenty-one of its thirty assertions fail against the policies this
-- file replaces.
--
-- Idempotent, like every file here.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- A contact is reached through the work it is attached to, and only through
-- work the reader holds. The two EXISTS clauses are the two join tables; there
-- is no third way in, which is the point.
CREATE OR REPLACE FUNCTION app_can_see_contact(ws text, contact text) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT NOT app_is_restricted_in(ws)
      OR EXISTS (
        SELECT 1
        FROM "OpportunityContact" oc
        JOIN "Opportunity" o ON o.id = oc."opportunityId"
        WHERE oc."contactId" = contact
          AND o."workspaceId" = ws
          AND app_can_see_anchor(ws, 'opportunity', o.id)
      )
      OR EXISTS (
        SELECT 1
        FROM "ProjectContact" pc
        JOIN "Project" p ON p.id = pc."projectId"
        WHERE pc."contactId" = contact
          AND p."workspaceId" = ws
          AND app_can_see_anchor(ws, 'project', p.id)
      )
  $$;

-- A company is reached through work that names it. Note what is absent: no
-- clause for Deal, because a restricted member has no deals, and none for
-- Contact.companyId, because a contact's employer is not itself a grant.
CREATE OR REPLACE FUNCTION app_can_see_company(ws text, company text) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT NOT app_is_restricted_in(ws)
      OR EXISTS (
        SELECT 1 FROM "Opportunity" o
        WHERE o."companyId" = company
          AND o."workspaceId" = ws
          AND app_can_see_anchor(ws, 'opportunity', o.id)
      )
      OR EXISTS (
        SELECT 1 FROM "Project" p
        WHERE p."companyId" = company
          AND p."workspaceId" = ws
          AND app_can_see_anchor(ws, 'project', p.id)
      )
  $$;

-- ---------------------------------------------------------------------------
-- Contact and Company
--
-- WITH CHECK matters as much as USING here. Attaching an unreachable contact to
-- work you hold would make it visible — a restricted member could otherwise
-- grant themselves any person in the workspace, one link at a time.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation ON "Contact";
CREATE POLICY tenant_isolation ON "Contact"
  USING (app_can_see_workspace("workspaceId") AND app_can_see_contact("workspaceId", id))
  WITH CHECK (app_can_see_workspace("workspaceId") AND app_can_see_contact("workspaceId", id));

DROP POLICY IF EXISTS tenant_isolation ON "Company";
CREATE POLICY tenant_isolation ON "Company"
  USING (app_can_see_workspace("workspaceId") AND app_can_see_company("workspaceId", id))
  WITH CHECK (app_can_see_workspace("workspaceId") AND app_can_see_company("workspaceId", id));

-- ---------------------------------------------------------------------------
-- Polymorphic attachments
--
-- 010 gave these opportunity and project arms and left contacts and companies
-- on the workspace rule for this step. A custom field value in particular can
-- hold anything somebody chose to record about a person.
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
                WHEN 'contact' THEN app_can_see_contact("workspaceId", "entityId")
                WHEN 'company' THEN app_can_see_company("workspaceId", "entityId")
                ELSE true
              END
        )
        WITH CHECK (
          app_can_see_workspace("workspaceId")
          AND CASE "entityType"
                WHEN 'opportunity' THEN app_can_see_anchor("workspaceId", 'opportunity', "entityId")
                WHEN 'project' THEN app_can_see_anchor("workspaceId", 'project', "entityId")
                WHEN 'contact' THEN app_can_see_contact("workspaceId", "entityId")
                WHEN 'company' THEN app_can_see_company("workspaceId", "entityId")
                ELSE true
              END
        )
    $p$, t);
  END LOOP;
END
$$;

COMMIT;
