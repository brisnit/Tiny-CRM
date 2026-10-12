import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { db, createTenant, cleanupTenants, type Tenant } from "../helpers/fixtures";
import { withTenantContext } from "../../src/lib/tenant-db";
import {
  integrationsAdvertised,
  integrationsEnabled,
  integrationsEntitled,
  requireIntegrations,
} from "../../src/lib/integrations/gate";
import { PLANS } from "../../src/lib/plans";
import { isPostgres } from "../../src/lib/env";

/**
 * SQLite has no row-level security, so "a workspace this context cannot see"
 * does not exist there — the read simply succeeds. Marking that one case rather
 * than the whole file, because every other assertion here is engine-independent
 * and should run in the fast suite too.
 */
const pgOnly = isPostgres ? undefined : { skip: "needs row-level security to be unreadable" };

/**
 * The two gates in front of connecting a mailbox: the rollout flag and the
 * plan.
 *
 * Both must pass, and they answer different questions — see
 * src/lib/integrations/gate.ts. The flag ships dark, so every test here that
 * wants the capability has to enable it for the workspace explicitly, which is
 * also the behaviour worth asserting: a workspace that was never switched on
 * cannot connect anything regardless of what it pays.
 */

let free: Tenant;
let pro: Tenant;
let lifetime: Tenant;

async function setFlag(workspaceId: string, enabled: boolean) {
  await db.featureFlag.upsert({
    where: { key_workspaceId: { key: "integrations", workspaceId } },
    create: { workspaceId, key: "integrations", enabled, updatedAt: new Date() },
    update: { enabled, updatedAt: new Date() },
  });
}

before(async () => {
  free = await createTenant("GateFree", { plan: "free" });
  pro = await createTenant("GatePro", { plan: "pro" });
  lifetime = await createTenant("GateLifetime", { plan: "legacy_lifetime" });
});

after(async () => {
  for (const t of [free, pro, lifetime]) {
    await db.featureFlag.deleteMany({ where: { workspaceId: t.workspaceId } });
  }
  await cleanupTenants([free, pro, lifetime]);
  await db.$disconnect();
});

const inContext = <T>(t: Tenant, fn: () => Promise<T>) =>
  withTenantContext(
    { workspaceIds: [t.workspaceId], userId: t.ownerId, restrictedWorkspaceIds: [] },
    fn,
  );

describe("the plan decides entitlement, read from the workspace owner", () => {
  test("Pro and the legacy plans are entitled; Free and Plus are not", async () => {
    // Asserted against the plan table as well as the resolver, so a plan added
    // later without a decision about sync shows up here rather than shipping
    // whatever the object literal happened to say.
    assert.equal(PLANS.free.capabilities.emailCalendarSync, false);
    assert.equal(PLANS.plus.capabilities.emailCalendarSync, false);
    assert.equal(PLANS.pro.capabilities.emailCalendarSync, true);
    assert.equal(PLANS.legacy_lifetime.capabilities.emailCalendarSync, true);
    assert.equal(PLANS.legacy_pro.capabilities.emailCalendarSync, true);

    assert.equal(await inContext(pro, () => integrationsEntitled(pro.workspaceId)), true);
    assert.equal(await inContext(free, () => integrationsEntitled(free.workspaceId)), false);
    assert.equal(
      await inContext(lifetime, () => integrationsEntitled(lifetime.workspaceId)),
      true,
      "a Lifetime entitlement lost access to sync",
    );
  });

  test("a workspace this context cannot see is not entitled", pgOnly, async () => {
    // Failing closed: the alternative is granting a paid capability because a
    // read came back empty.
    const entitled = await inContext(free, () => integrationsEntitled(pro.workspaceId));
    assert.equal(entitled, false, "an unreadable workspace was treated as entitled");
  });
});

describe("the flag and the plan must both pass", () => {
  test("an entitled workspace with the flag off cannot connect", async () => {
    await setFlag(pro.workspaceId, false);
    await assert.rejects(
      () => inContext(pro, () => requireIntegrations(pro.workspaceId)),
      /not enabled for this workspace/i,
      "the rollout flag did not gate an entitled workspace",
    );
    assert.equal(await inContext(pro, () => integrationsEnabled(pro.workspaceId)), false);
  });

  test("a flagged-on workspace that is not entitled is refused on the plan", async () => {
    await setFlag(free.workspaceId, true);
    await assert.rejects(
      () => inContext(free, () => requireIntegrations(free.workspaceId)),
      (error: unknown) => {
        const message = String((error as Error).message);
        assert.match(message, /Pro feature/i, "the refusal does not say what is needed");
        // And it says what happens to anything already imported, because that
        // is the question a customer actually has.
        assert.match(message, /Nothing already imported is removed/i);
        return true;
      },
    );
  });

  test("both on: permitted", async () => {
    await setFlag(pro.workspaceId, true);
    await inContext(pro, () => requireIntegrations(pro.workspaceId));
    assert.equal(await inContext(pro, () => integrationsEnabled(pro.workspaceId)), true);
  });

  test("the flag is read with the workspace in context, or it refuses to guess", async () => {
    // FeatureFlag is workspace-scoped and under RLS, so a read with no tenant
    // context silently falls back to the built-in default and ignores the
    // override. Three production defects came from exactly that, so the gate
    // throws rather than guessing.
    await assert.rejects(
      () => integrationsEnabled(pro.workspaceId),
      (error: unknown) => {
        // The reason is in `internal`; the customer-facing message is
        // deliberately generic, so asserting on `message` would pass for any
        // internal error at all.
        const app = error as { message: string; internal?: unknown };
        assert.match(String(app.internal), /tenant context/i, "not the context tripwire");
        assert.doesNotMatch(app.message, /tenant|flag|workspace/i,
          "an internal diagnostic reached the customer-facing message");
        return true;
      },
      "the gate read a workspace-scoped flag with no context",
    );
  });
});

describe("what may be advertised", () => {
  test("advertising follows the global flag, not a workspace override", async () => {
    // A public pricing page has no workspace and must not be able to read a
    // tenant's row. One workspace's override must not change what everyone is
    // promised.
    await setFlag(pro.workspaceId, true);
    assert.equal(
      await integrationsAdvertised(),
      false,
      "a workspace override changed what the public is told",
    );
  });
});
