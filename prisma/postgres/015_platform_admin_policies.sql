-- ---------------------------------------------------------------------------
-- Platform administration: the one cross-tenant read path, and its limits
-- ---------------------------------------------------------------------------
--
-- The owner-admin panel has to answer "which workspaces does this customer own
-- or belong to", and `Workspace` and `WorkspaceMember` are both under row-level
-- security. `User` is not, so the customer directory itself needs nothing here;
-- this file exists only for the membership half of that question.
--
-- Three properties were wanted, and this is the narrowest thing that has all
-- three:
--
--   1. **It cannot be forged by application code.** The alternative considered
--      was a `current_setting('app.is_admin')` GUC, set alongside the tenant
--      context. That is settable by any code path that opens a transaction,
--      which is exactly what an authorization check must not be. Membership
--      lives in a table instead, so forging it needs write access to that
--      table — and nothing customer-reachable has it (see below).
--   2. **It is read-only.** No admin policy is added for INSERT, UPDATE or
--      DELETE anywhere. The panel reads across tenants; it writes only to
--      `User`, `PlanGrant` and `AuditLog`, none of which need a policy for an
--      admin: `User` is outside RLS, `PlanGrant` is new and outside it, and
--      audit rows written by the panel carry the admin's own `actorId`, which
--      the existing policy already admits.
--   3. **It changes nothing for anyone else.** Each policy below is PERMISSIVE
--      and additive. With no row in `PlatformAdmin` the predicate is false and
--      the pre-existing policies decide exactly as they did before, which is
--      what the RLS suite asserts.
--
-- `PlatformAdmin` is itself protected the other way round: RLS is enabled with
-- **no policy at all**, so the application role cannot read or write it, while
-- `app_is_platform_admin()` — a SECURITY DEFINER function owned by the
-- migration role — can. An ordinary user therefore cannot add themselves, and
-- cannot even enumerate who is an admin.

ALTER TABLE "PlatformAdmin" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PlatformAdmin" FORCE ROW LEVEL SECURITY;
-- Deliberately no policy: deny-all for the application role.

-- SECURITY DEFINER so the check can see a table the caller cannot. STABLE so it
-- is evaluated once per statement rather than per row.
CREATE OR REPLACE FUNCTION app_is_platform_admin() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM "PlatformAdmin" pa
       WHERE pa."userId" IS NOT NULL
         AND pa."userId" = app_user_id()
    )
  $$;

REVOKE ALL ON FUNCTION app_is_platform_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_is_platform_admin() TO tinycrm_app;

-- Read-only, additive, and separate from `tenant_isolation` so that dropping
-- this file's policies restores the previous behaviour exactly.
DROP POLICY IF EXISTS platform_admin_reads ON "Workspace";
CREATE POLICY platform_admin_reads ON "Workspace"
  FOR SELECT USING (app_is_platform_admin());

DROP POLICY IF EXISTS platform_admin_reads ON "WorkspaceMember";
CREATE POLICY platform_admin_reads ON "WorkspaceMember"
  FOR SELECT USING (app_is_platform_admin());

-- `PlanGrant` holds no workspaceId and is scoped to a user. It is left outside
-- RLS for the same reason `User` is: it is read by the authentication path
-- before any workspace is known. Nothing customer-facing writes it — the only
-- writers are the admin actions, which check authorization in the application
-- and are audited.
