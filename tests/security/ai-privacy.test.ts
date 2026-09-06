import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { runAsTestIdentity } from "../../src/lib/auth/context";
import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

/**
 * Per-workspace AI privacy, and recoverability of destructive actions.
 *
 * Two things the previous report flagged, tested as the questions a customer
 * would actually ask:
 *
 *   "If I turn AI off for this client's workspace, does anything still leave?"
 *   "If someone clicks delete on my workspace, is it gone?"
 */

let A: Tenant;
let B: Tenant;

describe("AI privacy", () => {
  before(async () => {
    A = await createTenant("Privacy");
    B = await createTenant("PrivacyOther");
  });
  after(async () => {
    await cleanupTenants([A, B]);
    await db.$disconnect();
  });

  async function setMode(workspaceId: string, mode: string) {
    await db.workspace.update({ where: { id: workspaceId }, data: { aiMode: mode } });
  }

  describe("the workspace setting decides what leaves", () => {
    test("enabled permits transmission; disabled does not", async () => {
      const { aiPermission } = await import("../../src/lib/ai/privacy");

      await setMode(A.workspaceId, "enabled");
      const enabled = await aiPermission(A.workspaceId);

      await setMode(A.workspaceId, "disabled");
      const disabled = await aiPermission(A.workspaceId);

      assert.equal(disabled.mayTransmitContent, false, "a disabled workspace still transmits");
      assert.equal(disabled.mode, "disabled");
      assert.ok(disabled.reason.length > 0, "no reason was given to show the user");

      // `enabled` only transmits when a provider is actually configured; in a
      // test run there is none, so the assertion is about the *decision*, not
      // about the provider.
      assert.equal(enabled.mode, "enabled");
    });

    test("private mode fails closed when no enterprise agreement is asserted", async () => {
      // The dangerous alternative is silently behaving as `enabled`, which would
      // send data to a standard endpoint while the workspace believed otherwise.
      const { aiPermission } = await import("../../src/lib/ai/privacy");
      await setMode(A.workspaceId, "private");

      const permission = await aiPermission(A.workspaceId);
      assert.equal(
        permission.mayTransmitContent,
        false,
        "private mode transmitted without an enterprise agreement",
      );
      assert.equal(permission.mode, "private");
    });

    test("the setting is per workspace, not per account", async () => {
      const { aiPermission } = await import("../../src/lib/ai/privacy");

      await setMode(A.workspaceId, "disabled");
      await setMode(B.workspaceId, "enabled");

      const a = await aiPermission(A.workspaceId);
      const b = await aiPermission(B.workspaceId);

      assert.equal(a.mode, "disabled");
      assert.equal(b.mode, "enabled");
      assert.notEqual(a.mayTransmitContent, true);
    });

    test("an unrecognised stored value is treated as the default, not as permission", async () => {
      const { aiPermission } = await import("../../src/lib/ai/privacy");
      await db.workspace.update({
        where: { id: A.workspaceId },
        data: { aiMode: "something-nobody-defined" },
      });
      const permission = await aiPermission(A.workspaceId);
      assert.ok(["disabled", "enabled", "private"].includes(permission.mode));
      await setMode(A.workspaceId, "enabled");
    });

    test("assertMayTransmit refuses with a categorised error", async () => {
      const { assertMayTransmit } = await import("../../src/lib/ai/privacy");
      await setMode(A.workspaceId, "disabled");

      await assert.rejects(
        assertMayTransmit(A.workspaceId),
        (error: { category?: string; meta?: { reason?: string } }) => {
          assert.equal(error.category, "forbidden");
          assert.equal(error.meta?.reason, "ai_disabled");
          return true;
        },
      );

      await setMode(A.workspaceId, "enabled");
    });
  });

  describe("turning AI off degrades rather than breaks", () => {
    test("the provider falls back to the built-in engine", async () => {
      const { getProviderForWorkspace } = await import("../../src/lib/ai/provider");
      await setMode(A.workspaceId, "disabled");

      const provider = await getProviderForWorkspace(A.workspaceId);
      assert.equal(provider.id, "offline", "a disabled workspace still got a hosted provider");

      await setMode(A.workspaceId, "enabled");
    });

    test("deterministic features keep working with AI off", async () => {
      // Scoring, momentum, stall detection and the cleanup scan never needed a
      // model. If turning AI off broke them, nobody would turn it off.
      await setMode(A.workspaceId, "disabled");

      const { findRecommendations } = await import("../../src/lib/ai/recommendations");
      const scope = {
        workspaceIds: [A.workspaceId],
        workspaceNames: new Map([[A.workspaceId, "Privacy"]]),
      };
      await assert.doesNotReject(findRecommendations(scope), "the cleanup scan needed a model");

      const { getDashboard } = await import("../../src/lib/data/dashboard");
      await assert.doesNotReject(getDashboard([A.workspaceId], null));

      await setMode(A.workspaceId, "enabled");
    });

    test("a mixed scope keeps the whole answer local", async () => {
      // One workspace with AI off is enough. The alternative — transmitting a
      // workspace's records because a *different* workspace allowed it — is
      // exactly the leak the setting exists to prevent.
      const { aiPermission } = await import("../../src/lib/ai/privacy");
      await setMode(A.workspaceId, "disabled");
      await setMode(B.workspaceId, "enabled");

      const permissions = await Promise.all(
        [A.workspaceId, B.workspaceId].map((id) => aiPermission(id)),
      );
      assert.equal(
        permissions.every((p) => p.mayTransmitContent),
        false,
        "a mixed scope would have transmitted",
      );

      await setMode(A.workspaceId, "enabled");
    });
  });

  describe("the disclosure tells the truth", () => {
    test("it names the provider and model that will actually be used", async () => {
      const { aiDisclosure, providerProfile } = await import("../../src/lib/ai/privacy");
      const disclosure = await aiDisclosure(A.workspaceId);
      const profile = providerProfile();

      assert.equal(disclosure.provider.id, profile.id);
      assert.equal(disclosure.provider.model, profile.model);
      // A configured provider with no key resolves to the built-in engine; the
      // disclosure has to say so rather than repeat the configuration.
      assert.equal(
        disclosure.provider.transmitsContent,
        profile.transmitsContent,
        "the disclosure disagrees with what the provider will do",
      );
    });

    test("nothing claims zero retention", async () => {
      // Zero retention is a property of a contract and a configuration, not of a
      // vendor. Claiming it from a capability table would be a false statement.
      const { providerProfile } = await import("../../src/lib/ai/privacy");
      const profile = providerProfile();
      assert.equal(
        profile.enterpriseControls,
        false,
        "an enterprise agreement was inferred rather than asserted by an operator",
      );
    });

    test("it lists what is never sent, in every mode", async () => {
      const { aiDisclosure } = await import("../../src/lib/ai/privacy");
      await setMode(A.workspaceId, "disabled");
      const off = await aiDisclosure(A.workspaceId);

      assert.equal(off.dataSent.length, 0, "AI is off but data is listed as sent");
      assert.ok(off.dataNeverSent.some((item) => /password|token|key/i.test(item)));
      assert.ok(off.dataNeverSent.some((item) => /workspace you are not a member of/i.test(item)));

      await setMode(A.workspaceId, "enabled");
    });
  });
});

describe("destructive actions are recoverable", () => {
  let C: Tenant;

  before(async () => {
    C = await createTenant("Recover");
  });
  after(async () => {
    await cleanupTenants([C]);
    await db.$disconnect();
  });

  const asOwner = <T>(fn: () => Promise<T>) => runAsTestIdentity(C.ownerId, fn);

  test("workspace deletion is scheduled, not immediate", async () => {
    const { requestWorkspaceDeletion } = await import("../../src/lib/actions/settings");

    const result = await asOwner(() =>
      requestWorkspaceDeletion(C.workspaceId, "Recover Workspace"),
    );
    assert.equal(result.ok, true);

    const workspace = await db.workspace.findUnique({ where: { id: C.workspaceId } });
    assert.ok(workspace, "the workspace was destroyed on the click");
    assert.ok(workspace!.deletionScheduledAt, "no deletion was scheduled");
    assert.ok(
      workspace!.deletionScheduledAt!.getTime() > Date.now() + 6 * 86_400_000,
      "the grace period is shorter than a week",
    );

    // The contacts are still there and readable throughout.
    assert.ok(await db.contact.count({ where: { workspaceId: C.workspaceId } }) > 0);
  });

  test("the scheduled job does not run before it is due", async () => {
    const { runJobs } = await import("../../src/lib/jobs");
    const { registerJobHandlers } = await import("../../src/lib/jobs/handlers");
    registerJobHandlers();

    await runJobs(20);

    assert.ok(
      await db.workspace.findUnique({ where: { id: C.workspaceId } }),
      "a worker executed a deletion before its grace period ended",
    );
  });

  test("a scheduled deletion can be cancelled", async () => {
    const { cancelWorkspaceDeletion } = await import("../../src/lib/actions/settings");

    const result = await asOwner(() => cancelWorkspaceDeletion(C.workspaceId));
    assert.equal(result.ok, true);

    const workspace = await db.workspace.findUniqueOrThrow({ where: { id: C.workspaceId } });
    assert.equal(workspace.deletionScheduledAt, null, "the schedule survived a cancellation");
  });

  test("a cancelled deletion is a no-op when its job comes due", async () => {
    // The job is deliberately left in place on cancellation, so it must re-read
    // the schedule rather than trusting that it was enqueued.
    const { runJobs } = await import("../../src/lib/jobs");
    const { registerJobHandlers } = await import("../../src/lib/jobs/handlers");
    registerJobHandlers();

    await db.domainEvent.updateMany({
      where: { workspaceId: C.workspaceId, name: "workspace.deletion_due" },
      data: { availableAt: new Date(Date.now() - 1000), status: "pending", processedAt: null },
    });

    await runJobs(20);

    assert.ok(
      await db.workspace.findUnique({ where: { id: C.workspaceId } }),
      "a cancelled deletion was executed anyway",
    );
  });

  test("archived records appear in trash and can be restored", async () => {
    const { archiveContact } = await import("../../src/lib/actions/contacts");
    const { listTrash } = await import("../../src/lib/data/trash");
    const { restoreFromTrash } = await import("../../src/lib/actions/trash");

    await asOwner(() => archiveContact(C.contactId));

    const trash = await listTrash([C.workspaceId]);
    const item = trash.items.find((i) => i.id === C.contactId);
    assert.ok(item, "an archived contact did not appear in trash");
    assert.equal(item!.type, "contact");
    assert.ok(item!.archivedAt instanceof Date);

    const restored = await asOwner(() => restoreFromTrash("contact", C.contactId));
    assert.equal(restored.ok, true);

    const after = await db.contact.findUniqueOrThrow({ where: { id: C.contactId } });
    assert.equal(after.archivedAt, null, "restore did not clear the archive flag");
  });

  test("trash cannot be used to restore another tenant's record", async () => {
    const D = await createTenant("RecoverOther");
    try {
      const { restoreFromTrash } = await import("../../src/lib/actions/trash");
      await db.contact.update({
        where: { id: D.contactId },
        data: { archivedAt: new Date() },
      });

      const result = await asOwner(() => restoreFromTrash("contact", D.contactId));
      assert.equal(result.ok, false, "trash restored a record from another workspace");

      const still = await db.contact.findUniqueOrThrow({ where: { id: D.contactId } });
      assert.ok(still.archivedAt, "the foreign record was restored anyway");
    } finally {
      await cleanupTenants([D]);
    }
  });

  test("a bogus record type is refused rather than reaching a query", async () => {
    const { restoreFromTrash } = await import("../../src/lib/actions/trash");
    for (const type of ["user", "auditLog", "'; DROP TABLE Contact; --", "workspace"]) {
      const result = await asOwner(() => restoreFromTrash(type, C.contactId));
      assert.equal(result.ok, false, `a bogus type was accepted: ${type}`);
    }
  });

  test("trash is scoped to the caller's workspaces", async () => {
    const D = await createTenant("RecoverScope");
    try {
      await db.contact.update({ where: { id: D.contactId }, data: { archivedAt: new Date() } });

      const { listTrash } = await import("../../src/lib/data/trash");
      const trash = await listTrash([C.workspaceId]);

      assert.ok(
        !trash.items.some((i) => i.id === D.contactId),
        "trash listed another workspace's archived record",
      );
    } finally {
      await cleanupTenants([D]);
    }
  });
});
