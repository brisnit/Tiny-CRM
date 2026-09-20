-- ---------------------------------------------------------------------------
-- The job queue's claim step
--
-- The worker is a system process. To drain the outbox it has to claim due jobs
-- across every tenant, which is precisely what tenant context forbids: it has no
-- workspace context, so under RLS it sees an empty queue and nothing ever runs.
--
-- The options were: give the worker a BYPASSRLS role (a second privileged
-- credential in the deployment, and on Vercel the worker shares the app's
-- connection string, so it would privilege the whole application); leave
-- DomainEvent outside RLS (its payloads carry record names, so that publishes
-- one tenant's data to another); or expose exactly the one operation the worker
-- needs and nothing else.
--
-- This is the third. `app_claim_jobs` is SECURITY DEFINER, so it runs with the
-- table owner's rights and can therefore see the whole queue — but it is not a
-- general read. It can only:
--
--   * select rows that are due, unclaimed or whose claim has expired,
--   * mark them claimed by the caller,
--   * return their identifiers and payload.
--
-- It cannot be asked for a particular workspace's rows, cannot filter by
-- content, and returns nothing that is not already about to be processed. The
-- worker then handles each job inside `withTenantContext(job.workspaceId)`, so
-- every query the handler makes is scoped to that job's tenant and no other —
-- the privileged step is the claim, and it ends there.
--
-- search_path is pinned, because a SECURITY DEFINER function that resolves
-- object names through a caller-controlled search_path is a privilege-escalation
-- primitive.
--
-- Idempotent: safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- Time handling, which is where this went wrong twice.
--
-- Prisma maps DateTime to `timestamp(3)` WITHOUT time zone and writes the UTC
-- instant into it. Two comparisons therefore look right and are not:
--
--   * `availableAt <= now()` — now() is timestamptz, so PostgreSQL coerces it
--     to the server's local wall clock. West of UTC every job looks hours in
--     the future and the queue silently never drains.
--   * passing a JS Date as a `timestamp` parameter — the driver renders it in
--     local time, so the same skew reappears in the opposite direction and
--     jobs run before they are due.
--
-- The unambiguous form is to build "now" in the same representation the column
-- holds: `now() AT TIME ZONE 'UTC'` is a plain timestamp containing the UTC
-- wall clock, which is exactly what Prisma stored. No timestamp crosses the
-- driver boundary at all, so no conversion can be applied to it.
CREATE OR REPLACE FUNCTION app_claim_jobs(
  p_worker text,
  p_limit int,
  p_claim_ttl_seconds int
)
RETURNS TABLE (
  id text,
  name text,
  "workspaceId" text,
  "entityType" text,
  "entityId" text,
  "actorId" text,
  payload text,
  attempts int,
  "maxAttempts" int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE "DomainEvent" SET
    status = 'processing',
    "claimedBy" = p_worker,
    "claimedUntil" = (now() AT TIME ZONE 'UTC') + make_interval(secs => p_claim_ttl_seconds),
    attempts = attempts + 1
  WHERE id IN (
    SELECT e.id FROM "DomainEvent" e
    WHERE e."deadAt" IS NULL
      AND e."processedAt" IS NULL
      -- One millisecond of grace, and it is not a fudge factor.
      --
      -- `availableAt` is timestamp(3) and PostgreSQL *rounds* to that
      -- precision rather than truncating, so a value written at .8236 is
      -- stored as .824 — up to half a millisecond after the instant it
      -- describes. Measured on a cluster, 44.7% of inserts land ahead of their
      -- own clock that way, and under a UTC session 134 of 300 freshly
      -- inserted events were not yet due. This comparison carries full
      -- microsecond precision, so for that sub-millisecond window a
      -- just-created event is invisible to every worker.
      --
      -- What this is not: it is **not** the cause of the intermittent failure
      -- in the concurrent-dispatch test. That was a test-isolation defect —
      -- `dispatchSoon()` is fire-and-forget, so a detached dispatcher from an
      -- earlier action could still be in flight and legitimately take the
      -- claim, and the test wrongly required one of its own two calls to win.
      -- The two defects were found together and are unrelated; this one is
      -- proven on its own terms in tests/integration/events.test.ts by dating
      -- a row half a millisecond ahead and claiming it in the same
      -- transaction, where `now()` is the transaction timestamp and both
      -- statements therefore read an identical clock.
      --
      -- Impact without the fix is latency, not loss: the next pass takes the
      -- event and the sweep takes anything a pass misses. It is also invisible
      -- on a developer machine west of Greenwich, where `CURRENT_TIMESTAMP`
      -- coerced into a timestamp without time zone writes local wall clock and
      -- every event looks hours overdue — so the bug hid precisely where it
      -- would have been looked for.
      --
      -- A millisecond is far below the scheduling latency this queue already
      -- tolerates, and it does not change which events are eligible, only when
      -- one becomes eligible by a rounding artefact.
      AND e."availableAt" <= (now() AT TIME ZONE 'UTC') + interval '1 millisecond'
      AND (
        e.status = 'pending'
        OR e.status = 'failed'
        -- A claim whose worker died. Reclaimable rather than stranded.
        OR (e.status = 'processing' AND (e."claimedUntil" IS NULL OR e."claimedUntil" <= (now() AT TIME ZONE 'UTC')))
      )
    ORDER BY e."availableAt" ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING "DomainEvent".id, "DomainEvent".name, "DomainEvent"."workspaceId",
            "DomainEvent"."entityType", "DomainEvent"."entityId",
            "DomainEvent"."actorId", "DomainEvent".payload,
            "DomainEvent".attempts, "DomainEvent"."maxAttempts";
$$;

-- Only the application role. Not PUBLIC: a SECURITY DEFINER function granted to
-- PUBLIC is reachable by every role the database will ever have.
DROP FUNCTION IF EXISTS app_claim_jobs(text, int, timestamptz);
DROP FUNCTION IF EXISTS app_claim_jobs(text, int, timestamp, timestamp);
REVOKE ALL ON FUNCTION app_claim_jobs(text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_claim_jobs(text, int, int) TO tinycrm_app;

COMMIT;
