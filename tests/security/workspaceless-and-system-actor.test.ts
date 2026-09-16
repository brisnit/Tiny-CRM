import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

const require = createRequire(import.meta.url);

/**
 * Two rows that no policy had a home for.
 *
 * Both were found while threading identity through read contexts (Step 1), and
 * both are the same shape as the notification defects fixed there: a write that
 * PostgreSQL refuses, SQLite accepts, and nobody sees fail.
 *
 *   1. An AI thread with no workspace. `ensureThread` passes `workspaceId: null`
 *      when the question spans every workspace ("All businesses"), and
 *      `AiMessage`'s policy already tolerated that parent —
 *      `t."workspaceId" IS NULL OR app_can_see_workspace(...)`. `AiThread`'s own
 *      policy did not: it was in the directly-scoped list, so the check was
 *      `app_can_see_workspace(NULL)`, which is NULL, which is not TRUE. Fixed by
 *      prisma/postgres/007_account_scoped_ai_threads.sql, which scopes such a
 *      thread to the person instead — the shape 002 already uses for AuditLog
 *      and SecurityAlert.
 *
 *   2. The literal string "system" as a user id. `jobs/handlers.ts` passed
 *      `job.actorId ?? "system"` into `runAutomations`, which spent it on a
 *      task's `ownerId` and a notification's `userId` — both foreign keys to a
 *      real `User`. No user has the id "system", so the whole run failed into an
 *      AutomationRun row nobody reads. The actor is now nullable, and an action
 *      that needs a person says so.
 *
 * Measured as `tinycrm_app` over a raw connection where the policy is the thing
 * under test, and through the application where the symptom is. Skipped without
 * PostgreSQL; `npm run test:pg` supplies the role.
 */

const APP_URL = process.env.RLS_APP_DATABASE_URL;
const isPostgres = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");
const enabled = isPostgres && Boolean(APP_URL);

let A: Tenant;

async function asAppRole<T>(
  context: { workspaceIds: string[]; userId?: string },
  fn: (query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  const { Client } = require("pg");
  const client = new Client({ connectionString: APP_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_ids', $1, true)", [context.workspaceIds.join(",")]);
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

/** Runs a statement and reports whether the policy allowed it, rather than throwing. */
async function attempt(
  context: { workspaceIds: string[]; userId?: string },
  sql: string,
  params: unknown[],
): Promise<{ allowed: boolean; message: string }> {
  try {
    await asAppRole(context, (q) => q(sql, params));
    return { allowed: true, message: "" };
  } catch (error) {
    return { allowed: false, message: error instanceof Error ? error.message : String(error) };
  }
}

describe("rows that belong to a person, not a workspace", { skip: enabled ? false : "PostgreSQL with RLS_APP_DATABASE_URL only" }, () => {
  before(async () => {
    A = await createTenant("HomelessAlpha");
  });
  after(async () => {
    await cleanupTenants([A]);
    await db.$disconnect();
  });

  // -------------------------------------------------------------------------
  // 1. An AI thread with no workspace.
  // -------------------------------------------------------------------------
  describe("an AI thread with no workspace", () => {
    test("a thread scoped to a workspace is written and read normally", async () => {
      // The paired success: the common case must keep working.
      const id = `c${randomUUID().replace(/-/g, "")}`;
      const write = await attempt(
        { workspaceIds: [A.workspaceId], userId: A.ownerId },
        `INSERT INTO "AiThread" (id, "workspaceId", "userId", title, "updatedAt")
         VALUES ($1, $2, $3, 'Scoped thread', now())`,
        [id, A.workspaceId, A.ownerId],
      );
      assert.equal(write.allowed, true, `a workspace-scoped thread was refused: ${write.message}`);

      const rows = await asAppRole({ workspaceIds: [A.workspaceId], userId: A.ownerId }, (q) =>
        q(`SELECT id FROM "AiThread" WHERE id = $1`, [id]),
      );
      assert.equal(rows.length, 1, "a workspace-scoped thread was not readable by its owner");
    });

    test("a thread with no workspace belongs to its owner, and is written and read", async () => {
      const id = `c${randomUUID().replace(/-/g, "")}`;
      const write = await attempt(
        { workspaceIds: [A.workspaceId], userId: A.ownerId },
        `INSERT INTO "AiThread" (id, "workspaceId", "userId", title, "updatedAt")
         VALUES ($1, NULL, $2, 'Account-level thread', now())`,
        [id, A.ownerId],
      );
      assert.equal(write.allowed, true, `an account-level thread was refused: ${write.message}`);

      const own = await asAppRole({ workspaceIds: [A.workspaceId], userId: A.ownerId }, (q) =>
        q(`SELECT id FROM "AiThread" WHERE id = $1`, [id]),
      );
      assert.equal(own.length, 1, "the owner cannot read their own account-level thread");

      // With no workspace to scope it, the person is the only boundary there is.
      const colleague = await asAppRole({ workspaceIds: [A.workspaceId], userId: A.memberId }, (q) =>
        q(`SELECT id FROM "AiThread" WHERE id = $1`, [id]),
      );
      assert.deepEqual(colleague, [], "a colleague could read another person's account-level thread");

      const stranger = await attempt(
        { workspaceIds: [A.workspaceId], userId: A.memberId },
        `INSERT INTO "AiThread" (id, "workspaceId", "userId", title, "updatedAt")
         VALUES ($1, NULL, $2, 'Forged', now())`,
        [`c${randomUUID().replace(/-/g, "")}`, A.ownerId],
      );
      assert.equal(stranger.allowed, false, "one person wrote an account-level thread for another");
    });

    test("thread and message policies now agree about a workspace-less thread", async () => {
      const [messages] = await asAppRole({ workspaceIds: [A.workspaceId], userId: A.ownerId }, (q) =>
        q(`SELECT qual FROM pg_policies WHERE tablename = 'AiMessage' AND policyname = 'tenant_isolation'`),
      );
      const [threads] = await asAppRole({ workspaceIds: [A.workspaceId], userId: A.ownerId }, (q) =>
        q(`SELECT qual FROM pg_policies WHERE tablename = 'AiThread' AND policyname = 'tenant_isolation'`),
      );
      assert.match(String(messages?.qual), /IS NULL/, "AiMessage no longer tolerates a workspace-less thread");
      assert.match(String(threads?.qual), /app_user_id/, "AiThread does not scope a workspace-less thread to its owner");
    });

    test("the application can open an account-level conversation", async () => {
      // The symptom, through the path the chat route takes when the question
      // spans every workspace.
      const { runAsTestIdentity } = await import("../../src/lib/auth/context");
      const thread = await runAsTestIdentity(A.ownerId, async () => {
        const { ensureThread } = await import("../../src/lib/ai/crm-agent");
        return ensureThread(A.ownerId, null, "Across every workspace");
      });
      assert.ok(thread?.id, "ensureThread returned nothing for an account-level conversation");
      assert.equal(thread.workspaceId, null, "the thread was pinned to a workspace after all");
    });
  });

  // -------------------------------------------------------------------------
  // 2. A run with no actor behind it.
  // -------------------------------------------------------------------------
  describe("an automation run with no real actor", () => {
    const AUTOMATION_NAME = "Homeless rule";
    let automationId: string;

    before(async () => {
      // Actions touching the two columns that are foreign keys to a user: a
      // task's owner, and a notification's recipient.
      automationId = await asAppRole({ workspaceIds: [A.workspaceId], userId: A.ownerId }, async (q) => {
        const id = `c${randomUUID().replace(/-/g, "")}`;
        await q(
          `INSERT INTO "Automation" (id, "workspaceId", name, trigger, conditions, actions, enabled, "updatedAt")
           VALUES ($1, $2, $3, 'deal_stage_changed', '[]', $4, true, now())`,
          [
            id,
            A.workspaceId,
            AUTOMATION_NAME,
            JSON.stringify([
              { type: "notify_owner", message: "A deal moved" },
              { type: "create_task", title: "Follow the deal up" },
            ]),
          ],
        );
        return id;
      });
    });

    /** The runs this automation recorded, newest first. */
    async function runsFor(): Promise<{ status: string; message: string }[]> {
      const rows = await asAppRole({ workspaceIds: [A.workspaceId], userId: A.ownerId }, (q) =>
        q(`SELECT status, coalesce(message, '') AS message FROM "AutomationRun"
           WHERE "automationId" = $1 ORDER BY "createdAt" DESC`, [automationId]),
      );
      return rows.map((r) => ({ status: String(r.status), message: String(r.message) }));
    }

    test("a real actor's run succeeds, and writes both rows", async () => {
      const { runAutomations } = await import("../../src/lib/automations");
      await runAutomations({
        workspaceId: A.workspaceId,
        userId: A.ownerId,
        trigger: "deal_stage_changed",
        entityType: "deal",
        entityId: A.dealId,
        context: {},
      });

      const [latest] = await runsFor();
      assert.equal(latest?.status, "success", `the run failed: ${latest?.message}`);

      const notifications = await asAppRole({ workspaceIds: [A.workspaceId], userId: A.ownerId }, (q) =>
        q(`SELECT id FROM "Notification" WHERE "userId" = $1 AND title = 'A deal moved'`, [A.ownerId]),
      );
      assert.equal(notifications.length, 1, "the owner was not notified");

      const tasks = await asAppRole({ workspaceIds: [A.workspaceId] }, (q) =>
        q(`SELECT id FROM "Task" WHERE title = 'Follow the deal up' AND "ownerId" = $1`, [A.ownerId]),
      );
      assert.equal(tasks.length, 1, "the follow-up task was not created for the actor");
    });

    test("with no actor, the run still succeeds: the task is unassigned and the notification is skipped", async () => {
      const { runAutomations } = await import("../../src/lib/automations");
      await runAutomations({
        workspaceId: A.workspaceId,
        userId: null,
        trigger: "deal_stage_changed",
        entityType: "deal",
        entityId: A.dealId,
        context: {},
      });

      const [latest] = await runsFor();
      assert.equal(latest?.status, "success", `an actorless run failed: ${latest?.message}`);
      assert.match(latest?.message ?? "", /notify_owner skipped/, "the skipped notification was not recorded");

      const unassigned = await asAppRole({ workspaceIds: [A.workspaceId] }, (q) =>
        q(`SELECT id FROM "Task" WHERE title = 'Follow the deal up' AND "ownerId" IS NULL`),
      );
      assert.equal(unassigned.length, 1, "the task was not created, or was assigned to someone");

      const orphaned = await asAppRole({ workspaceIds: [A.workspaceId], userId: "system" }, (q) =>
        q(`SELECT id FROM "Notification" WHERE "userId" = 'system'`),
      );
      assert.deepEqual(orphaned, [], "a notification was written for a user that does not exist");
    });

    test("nothing in the source invents a user id", () => {
      // The defect was a string standing in for a person. It must not come back.
      const { readFileSync } = require("node:fs") as typeof import("node:fs");
      const { resolve } = require("node:path") as typeof import("node:path");
      const root = resolve(import.meta.dirname, "../..");
      for (const rel of ["src/lib/jobs/handlers.ts", "src/lib/automations.ts"]) {
        const source = readFileSync(resolve(root, rel), "utf8");
        assert.doesNotMatch(
          source,
          /userId: [^\n]*"system"/,
          `${rel} assigns the literal "system" as a user id`,
        );
      }
    });
  });
});
