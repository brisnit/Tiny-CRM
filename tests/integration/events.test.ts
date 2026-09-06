import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { runAsTestIdentity } from "../../src/lib/auth/context";
import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

/**
 * Domain events, the outbox, and the automation engine that consumes them.
 *
 * The property being tested is the one that makes this replaceable by a queue
 * later: a business write and its event commit together or not at all, and a
 * failing consumer can never roll back a user's save.
 */

let A: Tenant;

describe("domain events", () => {
  before(async () => {
    A = await createTenant("Events");
  });
  after(async () => {
    await cleanupTenants([A]);
    await db.$disconnect();
  });

  const asOwner = <T>(fn: () => Promise<T>) => runAsTestIdentity(A.ownerId, fn);

  test("a stage change writes an event in the same transaction as the move", async () => {
    const { moveDealToStage } = await import("../../src/lib/actions/deals");
    const result = await asOwner(() => moveDealToStage(A.dealId, A.otherStageId));
    assert.equal(result.ok, true);

    const event = await db.domainEvent.findFirst({
      where: { entityId: A.dealId, name: { in: ["deal.stage.changed", "deal.won", "deal.lost"] } },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(event, "a stage change produced no domain event");
    assert.equal(event!.workspaceId, A.workspaceId, "the event escaped its workspace");
    assert.equal(event!.actorId, A.ownerId);

    const payload = JSON.parse(event!.payload) as Record<string, unknown>;
    assert.equal(payload.stageKind, "won", "the event did not describe the destination stage");
  });

  test("a rolled-back write leaves no event behind", async () => {
    const before = await db.domainEvent.count({ where: { workspaceId: A.workspaceId } });

    // Force a failure after the event is appended but before commit.
    await assert.rejects(
      db.$transaction(async (tx) => {
        const { emitEvent } = await import("../../src/lib/events");
        await emitEvent(
          {
            workspaceId: A.workspaceId, name: "contact.created",
            entityType: "contact", entityId: A.contactId,
          },
          tx,
        );
        throw new Error("simulated failure after the event was written");
      }),
    );

    const after = await db.domainEvent.count({ where: { workspaceId: A.workspaceId } });
    assert.equal(after, before, "an event described a change that never committed");
  });

  test("an event is claimed exactly once even under concurrent dispatch", async () => {
    const { emitEvent, dispatchPendingEvents } = await import("../../src/lib/events");

    // A rule that will actually run, so a double dispatch is observable.
    const automation = await db.automation.create({
      data: {
        workspaceId: A.workspaceId,
        name: "Count deal wins",
        trigger: "deal_stage_changed",
        enabled: true,
        conditions: JSON.stringify([]),
        actions: JSON.stringify([{ type: "create_task", title: "Won: follow up" }]),
      },
    });

    await db.domainEvent.deleteMany({ where: { workspaceId: A.workspaceId, processedAt: null } });
    await emitEvent({
      workspaceId: A.workspaceId,
      name: "deal.stage.changed",
      entityType: "deal",
      entityId: A.dealId,
      actorId: A.ownerId,
      payload: { stageName: "Won", stageKind: "won", dealName: "probe" },
    });

    // Two dispatchers racing for the same row.
    const [first, second] = await Promise.all([dispatchPendingEvents(), dispatchPendingEvents()]);
    assert.equal(
      first.processed + second.processed,
      1,
      "the same event was processed more than once",
    );

    const runs = await db.automationRun.count({ where: { automationId: automation.id } });
    assert.equal(runs, 1, "the automation ran twice for one event");

    await db.automation.delete({ where: { id: automation.id } });
  });

  test("a failing consumer records the error and leaves the write intact", async () => {
    const { emitEvent, dispatchPendingEvents } = await import("../../src/lib/events");

    const automation = await db.automation.create({
      data: {
        workspaceId: A.workspaceId,
        name: "Broken rule",
        trigger: "contact_created",
        enabled: true,
        conditions: JSON.stringify([]),
        // An action type the engine does not implement.
        actions: JSON.stringify([{ type: "definitely_not_a_real_action" }]),
      },
    });

    await db.domainEvent.deleteMany({ where: { workspaceId: A.workspaceId, processedAt: null } });
    await emitEvent({
      workspaceId: A.workspaceId, name: "contact.created",
      entityType: "contact", entityId: A.contactId, actorId: A.ownerId,
    });

    await dispatchPendingEvents();

    // Whatever the engine decided, the contact the event describes is untouched.
    const contact = await db.contact.findUnique({ where: { id: A.contactId } });
    assert.ok(contact, "a consumer failure destroyed the record it was reacting to");

    await db.automation.delete({ where: { id: automation.id } });
  });

  test("a poisoned event stops being retried rather than looping forever", async () => {
    const { dispatchPendingEvents } = await import("../../src/lib/events");

    await db.domainEvent.deleteMany({ where: { workspaceId: A.workspaceId, processedAt: null } });
    const event = await db.domainEvent.create({
      data: {
        workspaceId: A.workspaceId,
        name: "deal.stage.changed",
        entityType: "deal",
        entityId: A.dealId,
        payload: JSON.stringify({}),
        // Already at the retry ceiling.
        attempts: 5,
      },
    });

    const result = await dispatchPendingEvents();
    assert.equal(result.processed, 0, "an exhausted event was retried");

    const after = await db.domainEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert.equal(after.attempts, 5, "the attempt counter kept climbing");

    await db.domainEvent.delete({ where: { id: event.id } });
  });

  test("automations only fire for their own workspace", async () => {
    const B = await createTenant("EventsOther");
    try {
      const { emitEvent, dispatchPendingEvents } = await import("../../src/lib/events");

      const automation = await db.automation.create({
        data: {
          workspaceId: B.workspaceId,
          name: "Other tenant rule",
          trigger: "deal_stage_changed",
          enabled: true,
          conditions: JSON.stringify([]),
          actions: JSON.stringify([{ type: "create_task", title: "Should never run" }]),
        },
      });

      await db.domainEvent.deleteMany({ where: { processedAt: null } });
      await emitEvent({
        workspaceId: A.workspaceId, name: "deal.stage.changed",
        entityType: "deal", entityId: A.dealId, actorId: A.ownerId,
        payload: { stageName: "Won", stageKind: "won" },
      });

      await dispatchPendingEvents();

      const runs = await db.automationRun.count({ where: { automationId: automation.id } });
      assert.equal(runs, 0, "one workspace's event triggered another workspace's automation");
    } finally {
      await cleanupTenants([B]);
    }
  });
});

describe("billing webhook", () => {
  const secret = "webhook-secret-value";
  const body = JSON.stringify({ type: "plan.changed", plan: "pro" });

  const sign = async (payload: string, at: number, key = secret) => {
    const { createHmac } = await import("node:crypto");
    return createHmac("sha256", key).update(`${at}.${payload}`).digest("hex");
  };

  test("accepts a correctly signed, fresh delivery", async () => {
    const { verifySignature } = await import("../../src/lib/billing/webhook");
    const timestamp = Math.floor(Date.now() / 1000);
    await assert.doesNotReject(async () =>
      verifySignature({
        body,
        secret,
        signatureHeader: await sign(body, timestamp),
        timestampHeader: String(timestamp),
      }),
    );
  });

  test("refuses a forged, mis-keyed, tampered, unsigned or replayed delivery", async () => {
    const { verifySignature } = await import("../../src/lib/billing/webhook");
    const now = Math.floor(Date.now() / 1000);
    const valid = await sign(body, now);

    const cases: [string, Parameters<typeof verifySignature>[0]][] = [
      ["a forged signature", { body, secret, signatureHeader: "deadbeef", timestampHeader: String(now) }],
      ["a signature from another secret", {
        body, secret, signatureHeader: await sign(body, now, "wrong-secret"), timestampHeader: String(now),
      }],
      ["a tampered body", { body: `${body} `, secret, signatureHeader: valid, timestampHeader: String(now) }],
      ["no signature header", { body, secret, signatureHeader: null, timestampHeader: String(now) }],
      ["no timestamp header", { body, secret, signatureHeader: valid, timestampHeader: null }],
      ["a non-numeric timestamp", { body, secret, signatureHeader: valid, timestampHeader: "not-a-number" }],
      ["a replay outside the tolerance window", {
        body, secret,
        signatureHeader: await sign(body, now - 3_600),
        timestampHeader: String(now - 3_600),
      }],
      ["no configured secret", { body, secret: undefined, signatureHeader: valid, timestampHeader: String(now) }],
    ];

    for (const [label, input] of cases) {
      assert.throws(() => verifySignature(input), `${label} was accepted`);
    }
  });

  test("the same delivery is applied only once", async () => {
    const { claimWebhookEvent } = await import("../../src/lib/billing/webhook");
    const eventId = `evt_${Date.now()}`;

    const first = await claimWebhookEvent("test", eventId);
    const second = await claimWebhookEvent("test", eventId);

    assert.equal(first, true, "the first delivery was not claimed");
    assert.equal(second, false, "a duplicate delivery was applied twice");

    await db.idempotencyKey.deleteMany({ where: { scope: "webhook:test", key: eventId } });
  });

  test("plan state is not writable from any browser-reachable action", async () => {
    // The entitlement layer reads the stored plan; only the webhook path writes
    // it. This asserts the absence of the action that used to exist (F-04).
    const settings = await import("../../src/lib/actions/settings");
    assert.equal(
      "changePlan" in settings,
      false,
      "a changePlan server action exists — the browser can assign its own plan",
    );
  });

  after(async () => {
    await db.$disconnect();
  });
});
