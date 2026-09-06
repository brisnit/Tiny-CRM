import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { db as observer, createTenant } from "../helpers/fixtures";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { db } from "../../src/lib/db";
import { withTenantContext } from "../../src/lib/tenant-db";
import { isPostgres } from "../../src/lib/env";

/**
 * Runtime proof that the request path participates in row-level security.
 *
 * Two connections are in play, and keeping them straight is the whole point of
 * this file:
 *
 *   ACTOR     `db` — the application's client, connected as `tinycrm_app`,
 *             bound by RLS. Every operation *claimed* to be RLS-protected runs
 *             here.
 *   OBSERVER  `observer` — the fixtures' client, privileged, used only to build
 *             the world and to read ground truth afterwards.
 *
 * The observer may check what happened. It must never perform the operation
 * under test: a privileged write proves nothing about an unprivileged one. The
 * earlier version of this suite blurred that line, and the result was a set of
 * isolation tests that passed because the application could not read *anything*
 * — an attack refused and an application broken are indistinguishable from the
 * attacker's side. Every test below therefore asserts both directions:
 * **authorised behaviour succeeds AND unauthorised behaviour fails.**
 */

const pg = isPostgres;
const skip = pg ? undefined : { skip: "PostgreSQL with RLS only" };

let A: Awaited<ReturnType<typeof createTenant>>;
let B: Awaited<ReturnType<typeof createTenant>>;

before(async () => {
  A = await createTenant("RlsA");
  B = await createTenant("RlsB");
});

// ---------------------------------------------------------------------------
// The guard on the guards
// ---------------------------------------------------------------------------

describe("the actor connection is genuinely unprivileged", () => {
  test("current_user is tinycrm_app, without superuser or BYPASSRLS", skip ?? {}, async () => {
    const [row] = await db.$queryRaw<
      { who: string; is_super: boolean; bypass: boolean; owned: number }[]
    >`
      SELECT current_user AS who,
             r.rolsuper AS is_super,
             r.rolbypassrls AS bypass,
             (SELECT count(*)::int FROM pg_tables
               WHERE schemaname = 'public' AND tableowner = current_user) AS owned
      FROM pg_roles r WHERE r.rolname = current_user
    `;
    assert.equal(row!.who, "tinycrm_app", "the suite is not running as the restricted role");
    assert.equal(row!.is_super, false, "a superuser is not bound by FORCE ROW LEVEL SECURITY");
    assert.equal(row!.bypass, false, "rolbypassrls is set — every assertion below would be vacuous");
    assert.equal(row!.owned, 0, "the actor owns tables, so it can change the policies it is bound by");
  });

  test("RLS is actually enforcing on this connection", skip ?? {}, async () => {
    // With no context, a tenant table must be empty. If this ever returns rows,
    // every isolation assertion in the repository is meaningless.
    const [row] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Contact"`;
    assert.equal(row!.n, 0, "the actor sees rows with no tenant context — RLS is not in force");
  });

  test("the observer is privileged, and is a different connection", skip ?? {}, async () => {
    const total = await observer.contact.count();
    assert.ok(total > 0, "the observer cannot see the fixtures it created");
  });
});

// ---------------------------------------------------------------------------
// §6 Membership discovery — the chicken-and-egg that produced the false green
// ---------------------------------------------------------------------------

describe("membership discovery", () => {
  test("a user can discover their own memberships", skip ?? {}, async () => {
    const actor = await runAsTestIdentity(A.ownerId, async () => {
      const { getActor } = await import("../../src/lib/auth/access");
      return getActor();
    });
    assert.ok(actor, "no actor resolved");
    assert.ok(
      actor!.memberships.length > 0,
      "a legitimate user could not discover their memberships, so no context can ever be built",
    );
    assert.ok(actor!.memberships.some((m) => m.id === A.workspaceId));
  });

  test("a user cannot enumerate another user's memberships", skip ?? {}, async () => {
    const seen = await withTenantContext({ workspaceIds: [], userId: A.ownerId }, async () =>
      db.workspaceMember.findMany({ select: { userId: true, workspaceId: true } }),
    );
    assert.ok(seen.length > 0, "the user cannot see their own membership either");
    assert.equal(
      seen.filter((m) => m.userId !== A.ownerId).length,
      0,
      "membership rows belonging to other users were visible",
    );
    assert.equal(
      seen.filter((m) => m.workspaceId === B.workspaceId).length,
      0,
      "workspace B's membership rows leaked",
    );
  });

  test("a user sees only workspaces they belong to", skip ?? {}, async () => {
    const seen = await withTenantContext({ workspaceIds: [], userId: A.ownerId }, async () =>
      db.workspace.findMany({ select: { id: true } }),
    );
    assert.ok(seen.some((w) => w.id === A.workspaceId), "own workspace not visible");
    assert.ok(!seen.some((w) => w.id === B.workspaceId), "another tenant's workspace was visible");
  });
});

// ---------------------------------------------------------------------------
// §7 Record authorisation
// ---------------------------------------------------------------------------

describe("record authorisation", () => {
  const resolve = async (userId: string, id: string) => {
    const { requireRecordAccess } = await import("../../src/lib/auth/access");
    return runAsTestIdentity(userId, () => requireRecordAccess("contact", id));
  };

  test("a legitimate record resolves", skip ?? {}, async () => {
    const got = await resolve(A.ownerId, A.contactId);
    assert.equal(got.workspaceId, A.workspaceId);
  });

  test("a foreign record is refused", skip ?? {}, async () => {
    await assert.rejects(() => resolve(A.ownerId, B.contactId), /not exist|not found/i);
  });

  test("a missing record is indistinguishable from a foreign one", skip ?? {}, async () => {
    let foreign = "";
    let missing = "";
    await resolve(A.ownerId, B.contactId).catch((e) => { foreign = String((e as Error).message); });
    await resolve(A.ownerId, `c${randomUUID().replace(/-/g, "")}`).catch((e) => {
      missing = String((e as Error).message);
    });
    assert.ok(foreign && missing, "expected both to reject");
    assert.equal(foreign, missing, "the error text discloses whether a foreign record exists");
  });
});

// ---------------------------------------------------------------------------
// §5 Fresh-account onboarding, end to end, as the restricted role
// ---------------------------------------------------------------------------

describe("fresh account onboarding", () => {
  test("a new user with no memberships can create their first workspace", skip ?? {}, async () => {
    const userId = `c${randomUUID().replace(/-/g, "")}`;
    await observer.user.create({
      data: { id: userId, email: `onboard-${userId}@test.local`, name: "Onboard Probe" },
    });

    // Before: genuinely no memberships.
    const before = await runAsTestIdentity(userId, async () => {
      const { getActor } = await import("../../src/lib/auth/access");
      return (await getActor())!.memberships.length;
    });
    assert.equal(before, 0, "the fixture user already had a workspace");

    const { provisionWorkspace } = await import("../../src/lib/workspaces/provision");
    const ws = await provisionWorkspace(userId, { name: "First Workspace" });

    // Ground truth, via the observer.
    const [members, pipelines, stages, statuses] = await Promise.all([
      observer.workspaceMember.count({ where: { workspaceId: ws.id } }),
      observer.pipeline.count({ where: { workspaceId: ws.id } }),
      observer.pipelineStage.count({ where: { pipeline: { workspaceId: ws.id } } }),
      observer.projectStatus.count({ where: { workspaceId: ws.id } }),
    ]);
    assert.equal(members, 1, "no membership was created for the owner");
    assert.ok(pipelines >= 2, `expected default pipelines, got ${pipelines}`);
    assert.ok(stages > 0, "pipelines have no stages");
    assert.ok(statuses > 0, "no default project statuses");

    // After: the user can now discover the workspace and read inside it.
    const after = await runAsTestIdentity(userId, async () => {
      const { getActor } = await import("../../src/lib/auth/access");
      return (await getActor())!.memberships.map((m) => m.id);
    });
    assert.ok(after.includes(ws.id), "the new workspace is not discoverable by its owner");

    const dashboardReads = await runAsTestIdentity(userId, async () => {
      const { getDashboard } = await import("../../src/lib/data/dashboard");
      return getDashboard([ws.id], null);
    });
    assert.ok(dashboardReads, "the dashboard could not read the new workspace");
  });

  test("the database refuses a workspace owned by someone else", skip ?? {}, async () => {
    const id = `c${randomUUID().replace(/-/g, "")}`;
    await assert.rejects(
      () =>
        withTenantContext({ workspaceIds: [id], userId: A.ownerId }, async () =>
          db.workspace.create({
            data: { id, name: "Stolen", slug: `stolen-${Date.now()}`, ownerId: B.ownerId },
          }),
        ),
      /row-level security/i,
      "an authenticated user created a workspace owned by another user",
    );
    assert.equal(await observer.workspace.count({ where: { id } }), 0, "the row was written anyway");
  });
});

// ---------------------------------------------------------------------------
// §8 Audit logging under the restricted role
// ---------------------------------------------------------------------------

describe("audit logging", () => {
  test("an ordinary mutation writes an audit row with the right actor and workspace", skip ?? {}, async () => {
    const before = await observer.auditLog.count({ where: { workspaceId: A.workspaceId } });

    const { createContact } = await import("../../src/lib/actions/contacts");
    const result = await runAsTestIdentity(A.ownerId, () =>
      createContact({ workspaceId: A.workspaceId, firstName: "Audit", lastName: "Probe" } as never),
    );
    assert.equal(result.ok, true, `the mutation itself failed: ${JSON.stringify(result)}`);

    const rows = await observer.auditLog.findMany({
      where: { workspaceId: A.workspaceId },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    assert.ok(rows.length > before, "no audit row was written — the write is failing silently again");
    const row = rows[0]!;
    assert.equal(row.workspaceId, A.workspaceId, "audit row names the wrong workspace");
    assert.equal(row.actorId, A.ownerId, "audit row names the wrong actor");
    assert.ok(row.createdAt instanceof Date);
  });

  test("one tenant cannot read another tenant's audit rows", skip ?? {}, async () => {
    const seen = await withTenantContext(
      { workspaceIds: [A.workspaceId], userId: A.ownerId },
      async () => db.auditLog.findMany({ select: { workspaceId: true } }),
    );
    assert.ok(seen.length > 0, "the tenant cannot read its own audit rows either");
    assert.equal(
      seen.filter((r) => r.workspaceId === B.workspaceId).length,
      0,
      "another tenant's audit rows were visible",
    );
  });

  test("the audit log stays immutable for the application role", skip ?? {}, async () => {
    for (const attempt of [
      () => db.$executeRaw`UPDATE "AuditLog" SET action = 'tampered'`,
      () => db.$executeRaw`DELETE FROM "AuditLog"`,
    ]) {
      await assert.rejects(
        () => withTenantContext({ workspaceIds: [A.workspaceId], userId: A.ownerId }, attempt),
        /permission denied/i,
        "the application role can rewrite the audit trail",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// §9 Worker
// ---------------------------------------------------------------------------

describe("the worker under the restricted role", () => {
  test("app_claim_jobs is not executable by PUBLIC", skip ?? {}, async () => {
    const [row] = await observer.$queryRaw<{ acl: string | null }[]>`
      SELECT array_to_string(proacl, ',') AS acl FROM pg_proc WHERE proname = 'app_claim_jobs'
    `;
    const acl = row?.acl ?? "";
    assert.ok(acl.length > 0, "the function has default (PUBLIC) privileges");
    assert.ok(!/(^|,)=X\//.test(acl), `PUBLIC can execute the claim function: ${acl}`);
    assert.match(acl, /tinycrm_app=X\//, "tinycrm_app cannot execute the claim function");
  });

  test("it is SECURITY DEFINER with a pinned search_path", skip ?? {}, async () => {
    const [row] = await observer.$queryRaw<{ sec: boolean; cfg: string | null }[]>`
      SELECT prosecdef AS sec, array_to_string(proconfig, ',') AS cfg
      FROM pg_proc WHERE proname = 'app_claim_jobs'
    `;
    assert.equal(row!.sec, true, "not SECURITY DEFINER, so the worker cannot claim across tenants");
    assert.match(
      row!.cfg ?? "",
      /search_path=/,
      "search_path is not pinned — a SECURITY DEFINER function without one is an escalation primitive",
    );
  });

  test("a job runs in its own tenant context and cannot reach another", skip ?? {}, async () => {
    const { emitEvent } = await import("../../src/lib/events");
    const { registerHandler, runJobs } = await import("../../src/lib/jobs");

    let sawOwn = -1;
    let sawForeign = -1;
    registerHandler("contact.created", async () => {
      sawOwn = await db.contact.count({ where: { workspaceId: A.workspaceId } });
      sawForeign = await db.contact.count({ where: { workspaceId: B.workspaceId } });
    });

    await emitEvent({
      workspaceId: A.workspaceId,
      name: "contact.created",
      entityType: "contact",
      entityId: A.contactId,
      actorId: A.ownerId,
      payload: {},
    });

    const result = await runJobs(10);
    assert.ok(result.processed > 0, "the job did not run");
    assert.ok(sawOwn > 0, "the handler could not read its own workspace");
    assert.equal(sawForeign, 0, "the handler read another tenant's rows");
  });
});

// ---------------------------------------------------------------------------
// §3 Pooled connection isolation — the required test
// ---------------------------------------------------------------------------

describe("pooled tenant context isolation", () => {
  test("concurrent A/B work never crosses, over many rounds", skip ?? {}, async () => {
    // Interleaves two tenants' work on a small pool so connections are reused
    // heavily. Tenant context is transaction-local, so the property under test
    // is that it neither leaks sideways into a concurrent transaction nor
    // forward into the next borrower of the same connection.
    const rounds = 30;
    const failures: string[] = [];

    const forTenant = async (
      tenant: typeof A,
      other: typeof B,
      label: string,
    ) => {
      const own = await withTenantContext(
        { workspaceIds: [tenant.workspaceId], userId: tenant.ownerId },
        async () => {
          const mine = await db.contact.count();
          const theirs = await db.contact.count({ where: { workspaceId: other.workspaceId } });
          // A write, too: reads alone would not prove the context applies to
          // WITH CHECK.
          const created = await db.contact.create({
            data: {
              workspaceId: tenant.workspaceId,
              firstName: label,
              lastName: "Pooled",
              fullName: `${label} Pooled`,
            },
            select: { id: true, workspaceId: true },
          });
          return { mine, theirs, created };
        },
      );
      if (own.theirs !== 0) failures.push(`${label}: saw ${own.theirs} rows from the other tenant`);
      if (own.mine === 0) failures.push(`${label}: saw none of its own rows`);
      if (own.created.workspaceId !== tenant.workspaceId) {
        failures.push(`${label}: write landed in ${own.created.workspaceId}`);
      }
    };

    for (let i = 0; i < rounds; i++) {
      await Promise.all([forTenant(A, B, `A${i}`), forTenant(B, A, `B${i}`)]);
    }

    assert.deepEqual(failures, [], failures.join("\n"));
  });

  test("context does not survive the transaction that set it", skip ?? {}, async () => {
    // The mechanism is SET LOCAL. If it were a session SET, the next borrower
    // of this connection would inherit the previous tenant's context — the
    // exact cross-tenant leak the mechanism exists to prevent.
    await withTenantContext({ workspaceIds: [A.workspaceId], userId: A.ownerId }, async () => {
      const [row] = await db.$queryRaw<{ v: string }[]>`
        SELECT current_setting('app.workspace_ids', true) AS v
      `;
      assert.equal(row!.v, A.workspaceId, "the context was not set inside the transaction");
    });

    // Outside any transaction the setting must be gone, and a bare read blind.
    for (let i = 0; i < 20; i++) {
      const [row] = await db.$queryRaw<{ v: string | null }[]>`
        SELECT current_setting('app.workspace_ids', true) AS v
      `;
      assert.ok(
        row!.v === null || row!.v === "",
        `tenant context persisted onto a pooled connection: ${row!.v}`,
      );
      const [count] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Contact"`;
      assert.equal(count!.n, 0, "a context-free read returned rows after a scoped transaction");
    }
  });

  test("a failed transaction does not strand its context", skip ?? {}, async () => {
    await assert.rejects(() =>
      withTenantContext({ workspaceIds: [A.workspaceId], userId: A.ownerId }, async () => {
        await db.contact.count();
        throw new Error("deliberate rollback");
      }),
    );
    const [row] = await db.$queryRaw<{ v: string | null }[]>`
      SELECT current_setting('app.workspace_ids', true) AS v
    `;
    assert.ok(row!.v === null || row!.v === "", "context survived a rolled-back transaction");
  });
});
