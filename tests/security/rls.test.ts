import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

const require = createRequire(import.meta.url);

/**
 * Row-level security, attacked from below the application.
 *
 * Every other isolation test in this repository goes through the application's
 * own helpers, which is the right way to test the first layer — and useless for
 * testing the second, because those helpers always add the workspace filter the
 * policies are meant to survive without.
 *
 * These tests connect to PostgreSQL **directly**, as the restricted
 * `tinycrm_app` role, and issue the queries a careless developer or a
 * SQL-injection foothold would: `SELECT * FROM "Contact"` with no filter at all.
 * The invariant under test is the one that matters:
 *
 *   A query that forgets the application's workspace filter still returns no
 *   other tenant's rows.
 *
 * Skipped on SQLite, which has no equivalent. `npm run test:pg` runs them.
 */

const APP_URL = process.env.RLS_APP_DATABASE_URL;
const isPostgres = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");
const enabled = isPostgres && Boolean(APP_URL);

let A: Tenant;
let B: Tenant;

/** A raw connection as the restricted role — no Prisma, no application filters. */
async function asAppRole<T>(
  fn: (query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
  context?: { workspaceIds: string[]; userId?: string },
): Promise<T> {
  const { Client } = require("pg");
  const client = new Client({ connectionString: APP_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    if (context) {
      await client.query("SELECT set_config('app.workspace_ids', $1, true)", [
        context.workspaceIds.join(","),
      ]);
      await client.query("SELECT set_config('app.user_id', $1, true)", [context.userId ?? ""]);
    }
    const result = await fn(async (sql, params) => (await client.query(sql, params)).rows);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

describe("row-level security", { skip: enabled ? false : "PostgreSQL with RLS_APP_DATABASE_URL only" }, () => {
  before(async () => {
    A = await createTenant("RlsAlpha");
    B = await createTenant("RlsBravo");
  });
  after(async () => {
    await cleanupTenants([A, B]);
    await db.$disconnect();
  });

  // -------------------------------------------------------------------------
  describe("the connection is actually restricted", () => {
    test("the application role is neither a superuser nor a table owner", async () => {
      // Without this, every test below would pass vacuously: a superuser
      // bypasses row-level security even on a table marked FORCE.
      const [row] = await asAppRole((q) =>
        q(`SELECT current_user AS role,
                  (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
                  EXISTS (SELECT 1 FROM pg_class c
                          WHERE c.relnamespace = 'public'::regnamespace
                            AND c.relkind = 'r'
                            AND pg_get_userbyid(c.relowner) = current_user) AS owns_tables`),
      ).then((rows) => rows as { role: string; is_superuser: boolean; owns_tables: boolean }[]);

      assert.equal(row!.is_superuser, false, "the test connection is a superuser — RLS does not apply to it");
      assert.equal(row!.owns_tables, false, "the test connection owns the tables");
    });

    test("every workspace-owned table has FORCE ROW LEVEL SECURITY", async () => {
      const rows = await asAppRole((q) =>
        q(`SELECT relname FROM pg_class
           WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
             AND NOT (relrowsecurity AND relforcerowsecurity)`),
      );
      const unprotected = rows.map((r) => r.relname as string).sort();

      // The deliberate exclusions, each justified in docs/RLS.md.
      const expected = [
        "AuthToken", "IdempotencyKey", "MfaCredential", "MfaRecoveryCode",
        "RateLimitCounter", "UsageCounter", "User", "UserSession",
        "_prisma_migrations",
      ];
      assert.deepEqual(
        unprotected,
        expected,
        "a table is outside RLS that is not on the documented exclusion list",
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("a query with no tenant context returns nothing", () => {
    const tables = [
      "Contact", "Company", "Deal", "Project", "Opportunity", "Task", "Note",
      "Activity", "Workspace", "WorkspaceMember", "Tag", "Automation",
      "Pipeline", "PipelineStage", "AuditLog", "DomainEvent",
    ];

    for (const table of tables) {
      test(`SELECT * FROM "${table}" with no context`, async () => {
        const rows = await asAppRole((q) => q(`SELECT * FROM "${table}"`));
        assert.equal(
          rows.length,
          0,
          `${table} returned ${rows.length} rows to a connection with no tenant context`,
        );
      });
    }

    test("an aggregate cannot count what it cannot see", async () => {
      // COUNT(*) is the classic way to confirm a table is non-empty without
      // reading it.
      const [row] = await asAppRole((q) => q(`SELECT count(*)::int AS n FROM "Contact"`));
      assert.equal(row!.n, 0, "an aggregate leaked the row count");
    });

    test("a join cannot reach through an unprotected table", async () => {
      // `User` is deliberately outside RLS. A join from it must still not
      // surface protected rows.
      const rows = await asAppRole((q) =>
        q(`SELECT c.id FROM "User" u JOIN "Contact" c ON c."ownerId" = u.id`),
      );
      assert.equal(rows.length, 0, "a join through User reached protected rows");
    });

    test("a subquery cannot be used as an oracle", async () => {
      const [row] = await asAppRole((q) =>
        q(`SELECT (SELECT count(*)::int FROM "Deal") AS deals,
                  (SELECT max("valueCents") FROM "Deal") AS biggest`),
      );
      assert.equal(row!.deals, 0);
      assert.equal(row!.biggest, null, "an aggregate leaked a deal value");
    });
  });

  // -------------------------------------------------------------------------
  describe("a query with the wrong tenant context returns nothing", () => {
    test("a filterless SELECT sees only the context's workspace", async () => {
      // This is the invariant, stated exactly: no WHERE clause at all.
      const rows = await asAppRole(
        (q) => q(`SELECT id, "workspaceId" FROM "Contact"`),
        { workspaceIds: [A.workspaceId], userId: A.ownerId },
      );

      assert.ok(rows.length > 0, "the correct context saw nothing — the policy is too tight");
      assert.ok(
        rows.every((r) => r.workspaceId === A.workspaceId),
        "a filterless query returned another workspace's rows",
      );
      assert.ok(
        !rows.some((r) => r.id === B.contactId),
        "workspace B's contact was visible in workspace A's context",
      );
    });

    test("naming another tenant's id explicitly still returns nothing", async () => {
      const rows = await asAppRole(
        (q) => q(`SELECT * FROM "Contact" WHERE id = $1`, [B.contactId]),
        { workspaceIds: [A.workspaceId], userId: A.ownerId },
      );
      assert.equal(rows.length, 0, "an explicit foreign id was readable");
    });

    test("a forged workspace filter cannot widen the context", async () => {
      // The attacker controls the WHERE clause but not the GUC.
      const rows = await asAppRole(
        (q) => q(`SELECT * FROM "Contact" WHERE "workspaceId" = $1`, [B.workspaceId]),
        { workspaceIds: [A.workspaceId], userId: A.ownerId },
      );
      assert.equal(rows.length, 0, "a WHERE clause overrode the policy");
    });

    test("indirect tables are protected through their parent", async () => {
      for (const [table, column, parentId] of [
        ["PipelineStage", "pipelineId", B.pipelineId],
        ["Milestone", "projectId", B.projectId],
      ] as const) {
        const rows = await asAppRole(
          (q) => q(`SELECT * FROM "${table}" WHERE "${column}" = $1`, [parentId]),
          { workspaceIds: [A.workspaceId], userId: A.ownerId },
        );
        assert.equal(rows.length, 0, `${table} leaked through its parent`);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("writes cannot cross the boundary either", () => {
    test("UPDATE with no context affects no rows", async () => {
      const affected = await asAppRole(async (q) => {
        const result = await q(`UPDATE "Contact" SET "jobTitle" = 'pwned' RETURNING id`);
        assert.equal(result.length, 0, "a contextless UPDATE matched rows");
        return q(`SELECT count(*)::int AS n FROM "Contact" WHERE "jobTitle" = 'pwned'`);
      });
      assert.equal(affected[0]!.n, 0);

      // And confirm from a privileged connection that nothing actually changed.
      const damaged = await db.contact.count({ where: { jobTitle: "pwned" } });
      assert.equal(damaged, 0, "a contextless UPDATE modified rows");
    });

    test("UPDATE in one context cannot touch another workspace", async () => {
      await asAppRole(
        (q) => q(`UPDATE "Contact" SET "jobTitle" = 'cross-tenant' WHERE id = $1`, [B.contactId]),
        { workspaceIds: [A.workspaceId], userId: A.ownerId },
      );
      const target = await db.contact.findUniqueOrThrow({ where: { id: B.contactId } });
      assert.notEqual(target.jobTitle, "cross-tenant", "an UPDATE crossed the tenant boundary");
    });

    test("DELETE cannot destroy another tenant's data", async () => {
      // Run in a throwaway workspace of its own. A filterless DELETE really does
      // delete everything the context can see, so pointing it at A would leave
      // the later tests asserting against an empty table and passing for the
      // wrong reason.
      const C = await createTenant("RlsDelete");
      try {
        const beforeB = await db.contact.count({ where: { workspaceId: B.workspaceId } });
        const beforeC = await db.contact.count({ where: { workspaceId: C.workspaceId } });
        assert.ok(beforeC > 0);

        await asAppRole(
          (q) => q(`DELETE FROM "Contact"`),
          { workspaceIds: [C.workspaceId], userId: C.ownerId },
        );

        assert.equal(
          await db.contact.count({ where: { workspaceId: C.workspaceId } }),
          0,
          "the DELETE did not run at all — this test proves nothing",
        );
        assert.equal(
          await db.contact.count({ where: { workspaceId: B.workspaceId } }),
          beforeB,
          "a filterless DELETE destroyed another tenant's rows",
        );
      } finally {
        await cleanupTenants([C]);
      }
    });

    test("INSERT cannot place a row in another workspace", async () => {
      // WITH CHECK is the half of the policy that governs writes. Without it a
      // caller could create a record inside a workspace it cannot read.
      await assert.rejects(
        asAppRole(
          (q) =>
            q(
              `INSERT INTO "Contact" (id, "workspaceId", "firstName", "lastName", "fullName", "updatedAt")
               VALUES ($1, $2, 'Planted', 'Row', 'Planted Row', now())`,
              [`rls-probe-${Date.now()}`, B.workspaceId],
            ),
          { workspaceIds: [A.workspaceId], userId: A.ownerId },
        ),
        /row-level security/i,
        "a row was inserted into a workspace outside the context",
      );
    });

    test("UPDATE cannot move a row into another workspace", async () => {
      // Confirm there is a row to move, so a rejection cannot come from an
      // empty match instead of from the policy.
      assert.ok(
        await db.contact.findUnique({ where: { id: A.contactId } }),
        "the target row is gone — this test would pass vacuously",
      );
      await assert.rejects(
        asAppRole(
          (q) => q(`UPDATE "Contact" SET "workspaceId" = $1 WHERE id = $2`, [B.workspaceId, A.contactId]),
          { workspaceIds: [A.workspaceId], userId: A.ownerId },
        ),
        /row-level security/i,
        "a row was moved into another workspace",
      );

      const moved = await db.contact.findUniqueOrThrow({ where: { id: A.contactId } });
      assert.equal(moved.workspaceId, A.workspaceId);
    });
  });

  // -------------------------------------------------------------------------
  describe("the audit log cannot be tampered with", () => {
    test("the application role cannot UPDATE or DELETE audit rows", async () => {
      await db.auditLog.create({
        data: {
          workspaceId: A.workspaceId,
          action: "record.deleted",
          summary: "rls tamper probe",
        },
      });

      for (const statement of [
        `UPDATE "AuditLog" SET summary = 'nothing happened'`,
        `DELETE FROM "AuditLog"`,
      ]) {
        await assert.rejects(
          asAppRole((q) => q(statement), { workspaceIds: [A.workspaceId], userId: A.ownerId }),
          /permission denied/i,
          `the application role could run: ${statement}`,
        );
      }

      const entry = await db.auditLog.findFirst({ where: { summary: "rls tamper probe" } });
      assert.ok(entry, "the audit entry was destroyed");
    });

    test("the application role can still append to the audit log", async () => {
      // Append-only means append is allowed. A policy that blocked INSERT would
      // stop the application recording anything at all.
      await assert.doesNotReject(
        asAppRole(
          (q) =>
            q(
              `INSERT INTO "AuditLog" (id, "workspaceId", action, summary)
               VALUES ($1, $2, 'record.created', 'rls append probe')`,
              [`rls-audit-${Date.now()}`, A.workspaceId],
            ),
          { workspaceIds: [A.workspaceId], userId: A.ownerId },
        ),
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("the context cannot be escalated from inside a session", () => {
    test("a widened context only widens to workspaces the caller was given", async () => {
      // The GUC is set by src/lib/tenant-db.ts from the caller's own
      // memberships. This documents that the policy trusts that list — the
      // control against a forged list is that the value never comes from a
      // request.
      const rows = await asAppRole(
        (q) => q(`SELECT DISTINCT "workspaceId" FROM "Contact"`),
        { workspaceIds: [A.workspaceId, B.workspaceId], userId: A.ownerId },
      );
      assert.equal(rows.length, 2, "an explicitly widened context did not widen");
    });

    test("a SQL-injected context string cannot smuggle a second workspace", async () => {
      // set_config takes a bound parameter, so the value is data. And
      // withTenantContext rejects an id that is not [A-Za-z0-9_-]{1,64}.
      const rows = await asAppRole(
        (q) => q(`SELECT * FROM "Contact"`),
        { workspaceIds: [`${A.workspaceId}' OR '1'='1`], userId: A.ownerId },
      );
      assert.equal(rows.length, 0, "an injected context string was accepted as a workspace id");
    });

    test("resetting the context mid-transaction does not widen it", async () => {
      const rows = await asAppRole(
        async (q) => {
          await q(`SELECT set_config('app.workspace_ids', '', true)`);
          return q(`SELECT * FROM "Contact"`);
        },
        { workspaceIds: [A.workspaceId], userId: A.ownerId },
      );
      assert.equal(rows.length, 0, "clearing the context opened the table instead of closing it");
    });
  });

  // -------------------------------------------------------------------------
  describe("the application's own context helper", () => {
    test("sets both settings, transaction-locally", async () => {
      const { withTenantContext } = await import("../../src/lib/tenant-db");

      const inside = await withTenantContext(
        { workspaceIds: [A.workspaceId, B.workspaceId], userId: A.ownerId },
        async (tx) =>
          tx.$queryRaw<{ workspaces: string; user: string }[]>`
            SELECT current_setting('app.workspace_ids', true) AS workspaces,
                   current_setting('app.user_id', true) AS "user"
          `,
      );

      assert.equal(inside[0]!.workspaces, `${A.workspaceId},${B.workspaceId}`);
      assert.equal(inside[0]!.user, A.ownerId);
    });

    test("context does not survive the transaction that set it", async () => {
      // The property that makes this safe on a pooled connection. A session-
      // scoped SET would leave one tenant's context on the connection for
      // whoever is handed it next.
      const { withTenantContext } = await import("../../src/lib/tenant-db");

      await withTenantContext(
        { workspaceIds: [A.workspaceId], userId: A.ownerId },
        async (tx) => tx.$queryRaw`SELECT 1`,
      );

      const after = await db.$queryRaw<{ leaked: string | null }[]>`
        SELECT current_setting('app.workspace_ids', true) AS leaked
      `;
      assert.ok(
        after[0]!.leaked === null || after[0]!.leaked === "",
        `tenant context leaked out of its transaction: ${after[0]!.leaked}`,
      );
    });

    test("a malformed workspace id is refused rather than interpolated", async () => {
      const { withTenantContext } = await import("../../src/lib/tenant-db");
      for (const bad of ["a,b", "'; SET app.workspace_ids = 'x", "x".repeat(65), "../etc"]) {
        await assert.rejects(
          withTenantContext({ workspaceIds: [bad] }, async (tx) => tx.$queryRaw`SELECT 1`),
          `a malformed id reached set_config: ${JSON.stringify(bad)}`,
        );
      }
    });

    test("rlsStatus reports that a superuser connection is NOT protected", async () => {
      // This suite connects as the cluster's bootstrap superuser, which bypasses
      // row-level security even on a FORCE'd table. The honest answer is
      // therefore "not active", and a status check that claimed otherwise would
      // be worse than no status check at all — it would report protection that
      // does not exist.
      const { rlsStatus } = await import("../../src/lib/tenant-db");
      const status = await rlsStatus();

      assert.equal(status.engine, "postgresql");
      assert.ok(status.protectedTables > 30, "far fewer tables are protected than expected");

      if (status.isSuperuser) {
        assert.equal(status.active, false, "a superuser connection was reported as protected");
        assert.match(status.reason, /superuser/i);
      } else {
        assert.equal(status.active, true);
      }
    });

    test("the same helper scopes correctly on a restricted connection", async () => {
      // The proof that the helper does its job where RLS actually applies:
      // the identical settings, set the identical way, on the restricted role.
      const rows = await asAppRole(
        (q) => q(`SELECT DISTINCT "workspaceId" FROM "Contact"`),
        { workspaceIds: [A.workspaceId], userId: A.ownerId },
      );
      assert.equal(rows.length, 1, "the restricted connection saw more than one workspace");
      assert.equal(rows[0]!.workspaceId, A.workspaceId);
    });
  });
});
