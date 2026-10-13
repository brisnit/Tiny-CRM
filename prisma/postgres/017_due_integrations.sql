-- ---------------------------------------------------------------------------
-- Finding the connections that are due an incremental sync
--
-- Same shape of problem as `app_claim_jobs` in 006, and the same answer. The
-- scheduler is a system process: to queue an incremental pass for every
-- connection that has fallen behind, it has to see connections across every
-- tenant. `Integration` is under a RESTRICTIVE policy keyed on `app_user_id()`
-- (016), and RLS is FORCED on it (002), so the table owner is subject to the
-- policy too — a context-less scan returns **no rows**, and would not error.
-- The scheduler would run every half hour, find nothing, log nothing, and no
-- mailbox would ever sync again after its backfill.
--
-- That failure mode is not hypothetical here. The same mistake, made inside
-- the page importer, produced a compare-and-set that matched zero rows and was
-- read as "the customer disconnected" — a wrong diagnosis that stopped the
-- chain silently. `assertTenantContext` exists because of it.
--
-- So, as in 006: not a BYPASSRLS role, not taking Integration out of RLS, but
-- exactly the one operation the scheduler needs.
--
-- `app_due_integrations` is SECURITY DEFINER and can therefore see every
-- connection — but it is not a general read. It:
--
--   * returns only connections that are connected, whose backfill has
--     completed and was not truncated, that are idle, and whose last sync is
--     older than the caller's threshold,
--   * returns only the four identifiers needed to enqueue a job,
--   * cannot be asked for a particular workspace, user or provider,
--   * returns no mail, no account address, no token, no cursor.
--
-- The caller then enqueues each job with that connection's own workspace and
-- owner as the actor, and the handler runs inside `withTenantContext` for that
-- tenant. The privileged step is this listing, and it ends here.
--
-- search_path is pinned: a SECURITY DEFINER function that resolves object
-- names through a caller-controlled search_path is a privilege-escalation
-- primitive.
--
-- Idempotent: safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- Time handling, exactly as 006 sets out and for the same reason. Prisma maps
-- DateTime to `timestamp(3)` WITHOUT time zone holding the UTC instant, so
-- comparing against `now()` — a timestamptz — coerces to the server's local
-- wall clock and skews the comparison by the server's offset. West of UTC that
-- makes every connection look freshly synced and nothing is ever due; east of
-- it, everything is due on every tick. `now() AT TIME ZONE 'UTC'` is a plain
-- timestamp holding the UTC wall clock, which is what the column holds. No
-- timestamp crosses the driver boundary, so no conversion can be applied to
-- one.
CREATE OR REPLACE FUNCTION app_due_integrations(
  p_idle_seconds int,
  p_limit int
)
RETURNS TABLE (
  id text,
  "workspaceId" text,
  "userId" text,
  "syncGeneration" int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT i.id, i."workspaceId", i."userId", i."syncGeneration"
  FROM "Integration" i
  WHERE i.status = 'connected'
    AND i."backfillCompletedAt" IS NOT NULL
    AND i."backfillTruncated" = false
    AND i."syncState" = 'idle'
    -- A connection that has somehow never synced is not "overdue by
    -- infinity"; it is one whose backfill bookkeeping is inconsistent, and
    -- queueing an incremental pass with no `lastSyncAt` to read from would
    -- silently re-read the whole backfill window. Left for the backfill.
    AND i."lastSyncAt" IS NOT NULL
    AND i."lastSyncAt" < (now() AT TIME ZONE 'UTC') - make_interval(secs => p_idle_seconds)
  ORDER BY i."lastSyncAt" ASC
  LIMIT p_limit;
$$;

-- Only the application role. Not PUBLIC: a SECURITY DEFINER function granted
-- to PUBLIC is reachable by every role the database will ever have.
--
-- Both halves are needed, and the first version of this file had only the
-- first. PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so
-- revoking it and stopping there leaves nobody but the owner able to call it:
-- the request path runs as `tinycrm_app`, which got `42501 permission denied
-- for function app_due_integrations` and no connection was ever scheduled.
-- SQLite has no such concept, so only the PostgreSQL suites could catch it.
REVOKE ALL ON FUNCTION app_due_integrations(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_due_integrations(int, int) TO tinycrm_app;

COMMIT;
