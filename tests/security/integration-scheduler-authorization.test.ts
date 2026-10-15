import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

import { db as observer } from "../helpers/fixtures";
import { db } from "../../src/lib/db";
import { isPostgres } from "../../src/lib/env";

/**
 * What the scheduler's privileged step is allowed to do.
 *
 * `app_due_integrations` (prisma/postgres/017) is the one place in the
 * application that reads `Integration` across every tenant. It is SECURITY
 * DEFINER, so it runs with the table owner's rights and the RESTRICTIVE policy
 * on that table does not confine it. That is the entire point and also the
 * entire risk: the protection is no longer the policy, it is the function's
 * own shape. So the shape is asserted rather than described.
 *
 * ACTOR    `db` — the application's client, connected as `tinycrm_app` with
 *          NOBYPASSRLS. This is the role the request path actually uses.
 * OBSERVER `observer` — privileged, reads the catalogue as ground truth.
 *
 * PostgreSQL only. SQLite has no roles, no policies and no SECURITY DEFINER,
 * and takes the ordinary-query path in schedule.ts, so a pass there would say
 * nothing at all.
 */
const pgOnly = isPostgres ? undefined : { skip: "PostgreSQL with RLS only" };

after(async () => {
  await db.$disconnect();
});

describe("the scheduler's privileged read is narrow, and only the app may call it", () => {
  test("the application role can execute it", pgOnly, async () => {
    // The half that was missing. PostgreSQL grants EXECUTE on a new function
    // to PUBLIC by default; 017 revoked that, and stopping there left nobody
    // but the owner able to call it. The request path runs as `tinycrm_app`
    // and got `42501 permission denied for function app_due_integrations`, so
    // the scan found nothing and no connection would ever have been
    // scheduled. SQLite could not have caught it.
    const rows = await db.$queryRaw<{ ok: boolean }[]>`
      SELECT has_function_privilege('tinycrm_app', 'app_due_integrations(int, int, int, int)', 'EXECUTE') AS ok
    `;
    assert.equal(rows[0]?.ok, true, "the application role cannot execute the scheduler's scan");
  });

  test("PUBLIC cannot execute it", pgOnly, async () => {
    // A SECURITY DEFINER function left executable by PUBLIC is reachable by
    // every role the database will ever have, including any added later for
    // reporting or support.
    const rows = await observer.$queryRaw<{ ok: boolean }[]>`
      SELECT has_function_privilege('public', 'app_due_integrations(int, int, int, int)', 'EXECUTE') AS ok
    `;
    assert.equal(rows[0]?.ok, false, "the scheduler's scan is callable by every role in the database");
  });

  test("it is SECURITY DEFINER with a pinned search_path", pgOnly, async () => {
    // Without a pinned search_path a SECURITY DEFINER function resolves object
    // names through whatever the caller set, which turns it into a
    // privilege-escalation primitive: a caller creates their own
    // `public.Integration` earlier in the path and the function reads that.
    const rows = await observer.$queryRaw<{ secdef: boolean; config: string[] | null }[]>`
      SELECT p.prosecdef AS secdef, p.proconfig AS config
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'app_due_integrations'
    `;
    assert.equal(rows.length, 1, "app_due_integrations is not installed exactly once");
    assert.equal(rows[0]!.secdef, true, "the scan is not SECURITY DEFINER, so it cannot see other tenants");
    assert.ok(
      (rows[0]!.config ?? []).some((entry) => entry.startsWith("search_path=")),
      "the scan has no pinned search_path",
    );
  });

  test("exactly one overload exists, so the old signature cannot linger", pgOnly, async () => {
    // 018 changed the argument list, and CREATE OR REPLACE cannot change a
    // function's return type — so the old two-argument version had to be
    // dropped explicitly. Two overloads would mean the application resolves
    // whichever matches its argument count, which is how a scheduler ends up
    // silently running the version without the recovery bounds.
    const rows = await observer.$queryRaw<{ args: string }[]>`
      SELECT pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'app_due_integrations'
    `;
    assert.equal(
      rows.length,
      1,
      `app_due_integrations has ${rows.length} overloads: ${rows.map((r) => r.args).join(" | ")}`,
    );
  });

  test("it returns identifiers only — no mail, address, token or cursor", pgOnly, async () => {
    /**
     * The function's return type is the boundary. If a later change added
     * `accountEmail` or `syncCursor` to it "for logging", a cross-tenant read
     * of customer data would exist with nothing in the way of it — and the
     * caller runs with no tenant context, so nothing downstream would refuse.
     */
    const rows = await observer.$queryRaw<{ args: string }[]>`
      SELECT pg_get_function_result(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'app_due_integrations'
    `;
    const returned = rows[0]!.args.toLowerCase();
    for (const column of ["id", "workspaceid", "userid", "syncgeneration", "reason"]) {
      assert.ok(returned.includes(column), `the scan no longer returns ${column}`);
    }
    for (const forbidden of ["accountemail", "credentials", "synccursor", "scopes", "lasterror"]) {
      assert.ok(
        !returned.includes(forbidden),
        `the scan returns ${forbidden}, which is customer data read across every tenant`,
      );
    }
  });

  test("a customer's own role cannot read another tenant's connections through the table", pgOnly, async () => {
    // The policy is still the protection everywhere that is not this one
    // function. Asserted here too, so a change that widened the policy to
    // make the scheduler simpler would fail loudly rather than quietly.
    const rows = await db.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM "Integration"
    `;
    assert.equal(
      Number(rows[0]!.count),
      0,
      "the application role read Integration rows with no tenant context, so the policy is not confining it",
    );
  });
});
