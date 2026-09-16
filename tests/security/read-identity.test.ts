import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

const require = createRequire(import.meta.url);

/**
 * What `app.user_id` does, and does not do, to a read.
 *
 * Step 1 of scoped access puts the acting user into every read's tenant context.
 * Today reads set `app.workspace_ids` alone (`withTenantContext({ workspaceIds })`
 * in every `src/lib/data/*` entry point), and two things follow from that, both
 * proven here rather than argued:
 *
 *   1. For a full-workspace member, identity changes *nothing*. Not one policy
 *      on a workspace-scoped table mentions `app_user_id()`, so the same rows
 *      come back either way. This is the guarantee that Step 1 is inert for
 *      everyone using the product today, and it is the baseline the later
 *      record-level work will be measured against.
 *
 *   2. For a *person*-scoped table it changes everything. `SavedView` and
 *      `Notification` are gated on `"userId" = app_user_id()`, and with no
 *      identity in context `app_user_id()` is NULL, so the comparison is NULL,
 *      so the row is filtered out. A read without identity sees none of its own
 *      notifications — silently, and only on PostgreSQL. SQLite has no policies,
 *      which is why every local test passed.
 *
 * These run as `tinycrm_app` over a raw connection: no Prisma, no application
 * filters, so what is measured is the policy itself. Skipped without
 * PostgreSQL; `npm run test:pg` supplies the role.
 */

const APP_URL = process.env.RLS_APP_DATABASE_URL;
const isPostgres = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");
const enabled = isPostgres && Boolean(APP_URL);

let A: Tenant;
let B: Tenant;

/** A raw connection as the restricted role, with the context a read would set. */
async function asAppRole<T>(
  context: { workspaceIds: string[]; userId?: string },
  fn: (query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  const { Client } = require("pg");
  const client = new Client({ connectionString: APP_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_ids', $1, true)", [
      context.workspaceIds.join(","),
    ]);
    // The distinction under test: "" is what a read sets today by omitting it.
    await client.query("SELECT set_config('app.user_id', $1, true)", [context.userId ?? ""]);
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

/** Every id visible in a table, in a stable order. */
async function visibleIds(
  table: string,
  context: { workspaceIds: string[]; userId?: string },
): Promise<string[]> {
  return asAppRole(context, async (q) => {
    const rows = await q(`SELECT id FROM "${table}" ORDER BY id`);
    return rows.map((row) => String(row.id));
  });
}

describe("identity in a read context", { skip: enabled ? false : "PostgreSQL with RLS_APP_DATABASE_URL only" }, () => {
  before(async () => {
    A = await createTenant("IdentityAlpha");
    B = await createTenant("IdentityBravo");
  });
  after(async () => {
    await cleanupTenants([A, B]);
    await db.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. The guarantee: nothing changes for a full-workspace member.
  // -------------------------------------------------------------------------
  describe("a workspace-scoped read returns the same rows with or without it", () => {
    /** Tables the fixtures populate, so the comparison is not between two empty sets. */
    const POPULATED = [
      "Company", "Contact", "Project", "Deal", "Opportunity",
      "Task", "Note", "Activity", "Pipeline", "ProjectStatus", "Automation", "Tag",
    ];
    /** Tables a workspace may legitimately have none of; equality still has to hold. */
    const MAY_BE_EMPTY = [
      "FileAsset", "CustomFieldDef", "CustomFieldValue", "TagLink", "CalendarEvent",
      "EmailMessage", "Integration", "AiThread", "ImportBatch", "WorkspaceInvitation", "DomainEvent",
    ];

    test("every populated table is identical, and is actually populated", async () => {
      const empties: string[] = [];
      for (const table of POPULATED) {
        const without = await visibleIds(table, { workspaceIds: [A.workspaceId] });
        const with_ = await visibleIds(table, { workspaceIds: [A.workspaceId], userId: A.ownerId });
        assert.deepEqual(with_, without, `${table} returned different rows once identity was in context`);
        if (without.length === 0) empties.push(table);
      }
      // Guard against a vacuous pass: two empty sets are equal and prove nothing.
      assert.deepEqual(empties, [], `these tables had no rows, so their comparison proved nothing: ${empties.join(", ")}`);
    });

    test("tables that may be empty are identical too", async () => {
      for (const table of MAY_BE_EMPTY) {
        const without = await visibleIds(table, { workspaceIds: [A.workspaceId] });
        const with_ = await visibleIds(table, { workspaceIds: [A.workspaceId], userId: A.ownerId });
        assert.deepEqual(with_, without, `${table} returned different rows once identity was in context`);
      }
    });

    test("the identity-aware membership and workspace policies do not widen this read", async () => {
      // 005_identity_policies.sql adds PERMISSIVE policies that are ORed in when
      // an identity is present: a member may always see their own membership row
      // and any workspace they belong to. For a member of one workspace, reading
      // inside that workspace, that can only re-admit rows already admitted.
      for (const table of ["Workspace", "WorkspaceMember"]) {
        const without = await visibleIds(table, { workspaceIds: [A.workspaceId] });
        const with_ = await visibleIds(table, { workspaceIds: [A.workspaceId], userId: A.ownerId });
        assert.deepEqual(with_, without, `${table} widened when identity entered the context`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 2. The bug: a person-scoped read needs identity or it silently sees nothing.
  // -------------------------------------------------------------------------
  describe("a person-scoped read", () => {
    const notificationId = `c${randomUUID().replace(/-/g, "")}`;

    before(async () => {
      // Written as the restricted role, in the owner's own context — the policy's
      // WITH CHECK requires exactly that, so this write also proves the write half.
      await asAppRole({ workspaceIds: [A.workspaceId], userId: A.ownerId }, (q) =>
        q(
          `INSERT INTO "Notification" (id, "workspaceId", "userId", type, title)
           VALUES ($1, $2, $3, 'task_due', 'Identity test notification')`,
          [notificationId, A.workspaceId, A.ownerId],
        ),
      );
    });

    test("sees nothing without an identity — this is what the shell does today", async () => {
      const rows = await asAppRole({ workspaceIds: [A.workspaceId] }, (q) =>
        q(`SELECT id FROM "Notification" WHERE "userId" = $1`, [A.ownerId]),
      );
      assert.deepEqual(rows, [], "a notification was visible without an identity — the policy has changed shape");
    });

    test("sees its own rows with one", async () => {
      const rows = await asAppRole({ workspaceIds: [A.workspaceId], userId: A.ownerId }, (q) =>
        q(`SELECT id FROM "Notification" WHERE "userId" = $1`, [A.ownerId]),
      );
      assert.deepEqual(rows.map((r) => String(r.id)), [notificationId], "the owner cannot see their own notification");
    });

    test("never another person's rows, even inside the same workspace", async () => {
      const rows = await asAppRole({ workspaceIds: [A.workspaceId], userId: A.memberId }, (q) =>
        q(`SELECT id FROM "Notification"`),
      );
      assert.deepEqual(rows, [], "a colleague could read another member's notifications");
    });
  });

  // -------------------------------------------------------------------------
  // 3. Identity narrows; it never reaches across a tenant boundary.
  // -------------------------------------------------------------------------
  describe("identity does not widen a read across workspaces", () => {
    test("another tenant's records stay invisible with an identity in context", async () => {
      const foreign = await asAppRole({ workspaceIds: [A.workspaceId], userId: A.ownerId }, async (q) => ({
        contacts: await q(`SELECT id FROM "Contact" WHERE id = $1`, [B.contactId]),
        companies: await q(`SELECT id FROM "Company" WHERE id = $1`, [B.companyId]),
        deals: await q(`SELECT id FROM "Deal" WHERE id = $1`, [B.dealId]),
        opportunities: await q(`SELECT id FROM "Opportunity" WHERE id = $1`, [B.opportunityId]),
        workspaces: await q(`SELECT id FROM "Workspace" WHERE id = $1`, [B.workspaceId]),
      }));
      assert.deepEqual(foreign, {
        contacts: [], companies: [], deals: [], opportunities: [], workspaces: [],
      }, "identity in context exposed another tenant's rows");
    });

    test("an identity with no workspaces in context reads nothing", async () => {
      const rows = await asAppRole({ workspaceIds: [], userId: A.ownerId }, (q) =>
        q(`SELECT id FROM "Contact"`),
      );
      assert.deepEqual(rows, [], "an empty workspace context still returned rows");
    });
  });

  // -------------------------------------------------------------------------
  // 3b. Writing a personal row needs the *recipient's* identity, not the author's.
  // -------------------------------------------------------------------------
  describe("writing a person-scoped row", () => {
    /** Attempts an insert and reports whether the policy allowed it. */
    async function tryInsert(context: { workspaceIds: string[]; userId?: string }, recipientId: string) {
      const id = `c${randomUUID().replace(/-/g, "")}`;
      try {
        await asAppRole(context, (q) =>
          q(
            `INSERT INTO "Notification" (id, "workspaceId", "userId", type, title)
             VALUES ($1, $2, $3, 'task_due', 'Write path')`,
            [id, A.workspaceId, recipientId],
          ),
        );
        return { allowed: true, message: "" };
      } catch (error) {
        return { allowed: false, message: error instanceof Error ? error.message : String(error) };
      }
    }

    test("is refused with no identity in context — the automation path", async () => {
      // src/lib/automations.ts runs in withTenantContext({ workspaceIds }) and
      // creates notifications inside it.
      const result = await tryInsert({ workspaceIds: [A.workspaceId] }, A.ownerId);
      assert.equal(result.allowed, false, "a notification was written with no identity in context");
      assert.match(result.message, /row-level security/i);
    });

    test("is refused when the context is someone other than the recipient — the job path", async () => {
      // src/lib/jobs/handlers.ts notifies a task's owner from a context whose
      // identity is the job's original actor, who is often a different person.
      const result = await tryInsert({ workspaceIds: [A.workspaceId], userId: A.memberId }, A.ownerId);
      assert.equal(result.allowed, false, "one member wrote a notification into another member's inbox");
      assert.match(result.message, /row-level security/i);
    });

    test("is allowed in the recipient's own context", async () => {
      const result = await tryInsert({ workspaceIds: [A.workspaceId], userId: A.ownerId }, A.ownerId);
      assert.equal(result.allowed, true, `the recipient's own context was refused: ${result.message}`);
    });
  });

  // -------------------------------------------------------------------------
  // 4. The symptom, through the application rather than the policy.
  // -------------------------------------------------------------------------
  describe("the shell's own notification read", () => {
    const shellNotificationId = `c${randomUUID().replace(/-/g, "")}`;

    before(async () => {
      await asAppRole({ workspaceIds: [A.workspaceId], userId: A.ownerId }, (q) =>
        q(
          `INSERT INTO "Notification" (id, "workspaceId", "userId", type, title)
           VALUES ($1, $2, $3, 'task_due', 'Shell read notification')`,
          [shellNotificationId, A.workspaceId, A.ownerId],
        ),
      );
    });

    test("returns the signed-in person's own notification", async () => {
      // The end the user actually sees. getShellData asks for
      // `notification.findMany({ where: { userId } })` on every page render, so
      // whether that returns anything is purely a question of whether the read's
      // tenant context carries an identity. Before this step it does not, and
      // this assertion fails on PostgreSQL while passing on SQLite — which is
      // exactly how the gap stayed invisible.
      const { runAsTestIdentity } = await import("../../src/lib/auth/context");

      const shell = await runAsTestIdentity(A.ownerId, async () => {
        const { getActor } = await import("../../src/lib/auth/access");
        const { getShellData } = await import("../../src/lib/data/shell");
        const actor = (await getActor())!;
        return getShellData(actor, "all", { workspaceIds: [A.workspaceId], userId: A.ownerId }, null);
      });

      assert.ok(
        shell.notifications.some((n) => n.id === shellNotificationId),
        "the shell did not return the signed-in person's own notification",
      );
      assert.ok(shell.unreadCount >= 1, `unread count was ${shell.unreadCount}`);
    });

    test("does not return a colleague's notification", async () => {
      const { runAsTestIdentity } = await import("../../src/lib/auth/context");

      const shell = await runAsTestIdentity(A.memberId, async () => {
        const { getActor } = await import("../../src/lib/auth/access");
        const { getShellData } = await import("../../src/lib/data/shell");
        const actor = (await getActor())!;
        return getShellData(actor, "all", { workspaceIds: [A.workspaceId], userId: A.memberId }, null);
      });

      assert.equal(
        shell.notifications.some((n) => n.id === shellNotificationId),
        false,
        "a colleague's notification reached another member's shell",
      );
    });
  });
});
