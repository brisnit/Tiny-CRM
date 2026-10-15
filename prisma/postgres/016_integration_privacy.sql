-- ---------------------------------------------------------------------------
-- A connection belongs to the person who made it, and imported mail is theirs
-- ---------------------------------------------------------------------------
--
-- Workspace membership is not consent to read a colleague's inbox. Before this
-- file, `Integration`, `EmailMessage` and `CalendarEvent` were gated by
-- `app_can_see_workspace()` alone, so any full-workspace member could read
-- every teammate's connection row — including the `credentials` column, which
-- is about to start holding real OAuth tokens — and every message imported from
-- their mailbox.
--
-- ## Why these are RESTRICTIVE, and in their own file
--
-- PostgreSQL combines PERMISSIVE policies with OR. Adding a second permissive
-- policy to narrow access therefore *widens* it, which is the opposite of the
-- intent and an easy mistake to make. RESTRICTIVE policies are ANDed with
-- everything else, so these can only ever subtract.
--
-- Keeping them in a separate file matters for a second reason. The obvious
-- alternative was to edit `tenant_isolation` in 010_record_scope.sql to include
-- the owner test. That policy is dropped and recreated by 010, and an operator
-- re-applies 010 after any migration that adds a table — at which point the
-- narrowing would silently disappear, with every test still passing because the
-- permissive policy alone looks correct. A restrictive policy in its own file
-- cannot be clobbered that way.
--
-- ## The deny-by-default property
--
-- `app_user_id()` returns NULL when the context is unset, and `x = NULL` is
-- NULL rather than TRUE, so a connection with no identity reads nothing here.
-- Service code that legitimately needs to act for a person — the sync worker —
-- must therefore run inside that person's tenant context rather than a bare
-- one. That is a deliberate constraint, not an inconvenience: a worker with no
-- user is a worker that could import into the wrong mailbox.

-- ---------------------------------------------------------------------------
-- Integration
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS integration_belongs_to_connector ON "Integration";
CREATE POLICY integration_belongs_to_connector ON "Integration"
  AS RESTRICTIVE
  USING ("userId" = app_user_id())
  WITH CHECK ("userId" = app_user_id());

-- ---------------------------------------------------------------------------
-- Imported mail and events
-- ---------------------------------------------------------------------------
--
-- `visibility <> 'private'` rather than `= 'workspace'`, so a value nobody has
-- thought of yet is treated as private rather than as public. Seeded
-- demonstration rows are 'workspace' and stay visible to the whole workspace,
-- which is what they are.
--
-- A private row whose `ownerUserId` is NULL is readable by nobody. That should
-- not happen — the sync worker always sets an owner — and if it ever does, the
-- row being invisible is the failure worth having.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['EmailMessage', 'CalendarEvent'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS imported_is_owner_private ON %I', t);
    EXECUTE format($p$
      CREATE POLICY imported_is_owner_private ON %I
        AS RESTRICTIVE
        USING ("visibility" <> 'private' OR "ownerUserId" = app_user_id())
        WITH CHECK ("visibility" <> 'private' OR "ownerUserId" = app_user_id())
    $p$, t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
--
-- Three restrictive policies, and the tables still FORCEd. tests/security/
-- integration-privacy.test.ts asserts the behaviour against the restricted
-- application role, which is the only check that actually proves any of this.

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(expected, ', ') INTO missing
  FROM (VALUES
    ('Integration', 'integration_belongs_to_connector'),
    ('EmailMessage', 'imported_is_owner_private'),
    ('CalendarEvent', 'imported_is_owner_private')
  ) AS wanted(tbl, expected)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_policies p
     WHERE p.tablename = wanted.tbl
       AND p.policyname = wanted.expected
       AND p.permissive = 'RESTRICTIVE'
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'restrictive policies missing or not restrictive: %', missing;
  END IF;
END
$$;
