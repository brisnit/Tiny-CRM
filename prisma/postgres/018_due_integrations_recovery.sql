-- ---------------------------------------------------------------------------
-- Recovering a sync chain that stopped
--
-- 017 scheduled connections that were `idle` and overdue. That is every
-- connection whose last pass finished. It is not the one that most needs
-- attention: a chain can stop *mid-flight* and leave the row saying `syncing`
-- or `backfilling` forever.
--
-- Two ways that happens, both real:
--
--   * the job dead-letters. `integration.sync` gets five attempts; a provider
--     outage longer than the backoff, or any bug in the handler, exhausts them
--     and the row is marked `dead`. Nothing then touches the connection again.
--   * the worker dies between the page transaction committing and the next
--     page being enqueued. The row says `syncing` and no job exists at all.
--
-- In both cases `startIncremental` refuses the connection — it only accepts
-- `idle` — so the scheduler skips it on every tick, forever, while Settings
-- still says "Connected". That is the silent stop this release has already
-- been bitten by twice, and 017 did not close it.
--
-- This replaces the function with one that returns both kinds, labelled, and
-- adds the three bounds that keep recovery from becoming a loop:
--
--   1. **Never while a job is alive.** A connection with a `pending`,
--      `failed` (retrying) or `processing` sync job is the queue's business,
--      not the scheduler's. Restarting one would run two chains against the
--      same connection, racing for its cursor and its page budget. The job
--      queue already reclaims a `processing` row whose worker died — its
--      claim expires and `app_claim_jobs` takes it — so a live row of any of
--      those three statuses means recovery must stand well back. Only when no
--      live job remains is the chain genuinely stopped.
--   2. **Only once it is stale.** A chain mid-flight is indistinguishable
--      from one that stopped a second ago, so a connection is not considered
--      interrupted until its last page is older than the caller's threshold.
--   3. **A bounded number of times.** `recoveryAttempts` counts consecutive
--      recoveries since the last pass that completed. At the cap the
--      scheduler stops returning the connection and the interface says it
--      needs attention. Recovering forever would hide a broken connection
--      behind an infinite retry, which is the same lie as "Connected".
--
-- Eligibility is otherwise unchanged and deliberately strict: `connected`
-- only, so a disconnected, errored, reauth-required or suspended connection is
-- never restarted; `backfillCompletedAt` set and `backfillTruncated` false, so
-- an import stopped at the page cap waits for the customer to resume it rather
-- than being quietly restarted under them; and `lastSyncAt` not null.
--
-- The generation is returned, not re-read later, so a disconnect racing the
-- scheduler produces a job whose generation no longer matches and which
-- therefore stands down — the compare-and-set in the page importer is
-- untouched by any of this. Cursors are likewise untouched: a recovered chain
-- starts a fresh incremental pass from `lastSyncAt`, and de-duplication on
-- (workspace, owner, provider, externalId) makes the overlap free.
--
-- Still SECURITY DEFINER for the reason 017 gives, still returning
-- identifiers and nothing else, still pinned and still granted only to
-- tinycrm_app.
--
-- Idempotent: safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- The signature changes, so the old one has to go explicitly: CREATE OR
-- REPLACE cannot change a function's return type, and leaving both would mean
-- the application resolves whichever matches its argument count.
DROP FUNCTION IF EXISTS app_due_integrations(int, int);

CREATE OR REPLACE FUNCTION app_due_integrations(
  p_idle_seconds int,
  p_stale_seconds int,
  p_max_recovery int,
  p_limit int
)
RETURNS TABLE (
  id text,
  "workspaceId" text,
  "userId" text,
  "syncGeneration" int,
  -- 'due' for an ordinary overdue pass, 'recovery' for an interrupted chain.
  -- The caller needs to tell them apart: only a recovery increments the
  -- attempt counter, and only a recovery is allowed to move a row out of a
  -- non-idle state.
  reason text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    i.id,
    i."workspaceId",
    i."userId",
    i."syncGeneration",
    CASE WHEN i."syncState" = 'idle' THEN 'due' ELSE 'recovery' END AS reason
  FROM "Integration" i
  WHERE i.status = 'connected'
    AND i."backfillCompletedAt" IS NOT NULL
    AND i."backfillTruncated" = false
    AND i."lastSyncAt" IS NOT NULL
    AND i."recoveryAttempts" < p_max_recovery
    AND (
      -- Ordinary: finished, and overdue.
      (
        i."syncState" = 'idle'
        AND i."lastSyncAt" < (now() AT TIME ZONE 'UTC') - make_interval(secs => p_idle_seconds)
      )
      OR
      -- Interrupted: left mid-chain, and stale enough that it is not simply
      -- in progress.
      (
        i."syncState" IN ('syncing', 'backfilling')
        AND i."lastSyncAt" < (now() AT TIME ZONE 'UTC') - make_interval(secs => p_stale_seconds)
      )
    )
    -- Bound 1. Any live job means the queue still owns this connection.
    -- `dead` and `done` are not live: a dead-lettered chain is exactly what
    -- recovery is for, and a done one left the row behind.
    AND NOT EXISTS (
      SELECT 1 FROM "DomainEvent" e
      WHERE e.name = 'integration.sync'
        AND e."entityId" = i.id
        AND e.status IN ('pending', 'failed', 'processing')
    )
  ORDER BY i."lastSyncAt" ASC
  LIMIT p_limit;
$$;

-- Only the application role. Both halves: PostgreSQL grants EXECUTE on a new
-- function to PUBLIC by default, so the REVOKE without the GRANT leaves the
-- request path unable to call it at all — which is how 017 shipped, and what
-- `42501 permission denied for function app_due_integrations` was.
REVOKE ALL ON FUNCTION app_due_integrations(int, int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_due_integrations(int, int, int, int) TO tinycrm_app;

COMMIT;
