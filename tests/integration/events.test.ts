import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { runAsTestIdentity } from "../../src/lib/auth/context";
import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";
import { isPostgres } from "../../src/lib/env";

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
    const emitted = await db.domainEvent.findFirstOrThrow({
      where: { workspaceId: A.workspaceId, name: "deal.stage.changed" },
      orderBy: { createdAt: "desc" },
    });

    // The invariant is "claimed at most once", and the authority for it is the
    // row, not the return values.
    //
    // This assertion used to be `first.processed + second.processed === 1`,
    // which quietly required one of *these two* calls to be the winner. It is
    // not entitled to that. `dispatchSoon()` is fire-and-forget, so a detached
    // dispatcher started by an earlier action in this same process can still be
    // in flight and legitimately take the claim — at which point both of these
    // return zero and the old assertion failed, reporting a duplicate that had
    // not happened. That is a defect in the test, not in the queue: a third
    // dispatcher winning is exactly what the queue is built to survive.
    //
    // `attempts` is incremented once, inside the claiming UPDATE, so it counts
    // claims by every dispatcher rather than the two this test happens to hold
    // references to. It is readable immediately and needs nothing to settle.
    assert.equal(
      emitted.attempts,
      1,
      `the event was claimed ${emitted.attempts} times; exactly one claim may ever succeed`,
    );
    assert.ok(
      first.processed + second.processed <= 1,
      `both explicit dispatchers processed the same event ` +
        `(${first.processed} and ${second.processed}) — the claim did not exclude one of them`,
    );
    // No assertion on `claimedBy`: a successful run releases the claim
    // (jobs.ts sets processedAt and clears claimedBy together), so it is null
    // for exactly the outcome this test wants. `attempts` is the durable
    // record — 1 means claimed once, 0 would mean never claimed at all, so the
    // equality above is not vacuous.

    // The side effect, in the direction that can be proven without waiting:
    // whoever won, the rule must not have run twice. Whether it eventually runs
    // *once* is a completion property, and this process offers no way to await a
    // detached dispatcher — see the note in the suite header.
    const runs = await db.automationRun.count({ where: { automationId: automation.id } });
    assert.ok(runs <= 1, `the automation ran ${runs} times for one event`);

    await db.automation.delete({ where: { id: automation.id } });
  });

  test("an event is claimable the instant it exists", isPostgres ? {} : { skip: "the claim predicate is PostgreSQL" }, async () => {
    // A separate defect from the one above, proven separately.
    //
    // `availableAt` is timestamp(3) and PostgreSQL *rounds* to that precision,
    // so a row written at .8236 is stored as .824 — up to half a millisecond
    // after the instant it describes. Measured on a cluster, 44.7% of inserts
    // land ahead of their own clock that way, and under a UTC session 134 of
    // 300 freshly inserted events were not yet due. The comparison value in
    // the claim carries full microsecond precision, so for that sub-millisecond
    // window a just-created event is invisible to every worker.
    //
    // Nothing is lost to it — the next pass takes the event — and it is not the
    // cause of the concurrency flake above. It is its own bug and this is its
    // own proof.
    //
    // The proof is exact rather than timed. `now()` is the *transaction*
    // timestamp, so a statement that dates the row and a claim in the same
    // transaction read an identical clock: half a millisecond ahead is half a
    // millisecond ahead, whatever the machine or the elapsed round-trips. An
    // earlier version of this test dated the row against one clock and claimed
    // against another a few milliseconds later, which made it detect the old
    // predicate roughly one run in ten — a regression test that misses the
    // regression.
    //
    // The whole thing runs in a transaction that is always rolled back:
    // `app_claim_jobs` is deliberately global, because the worker has no
    // workspace, so a real call would mark any other test's pending events
    // `processing` and strand them for the claim's lifetime.
    class Rollback extends Error {
      constructor(readonly claimed: string[]) { super("probe complete"); }
    }
    const dueWithin = async (offset: string, ids: string[]): Promise<string[]> => {
      try {
        await db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE "DomainEvent" SET "availableAt" = (now() AT TIME ZONE 'UTC') + interval '${offset}'
             WHERE id = ANY($1::text[])`, ids);
          const rows = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM app_claim_jobs('availability-probe', 100::int, 60::int)`;
          throw new Rollback(rows.map((row) => row.id));
        });
      } catch (error) {
        if (error instanceof Rollback) return error.claimed;
        throw error;
      }
      return [];
    };

    const event = await db.domainEvent.create({
      data: {
        workspaceId: A.workspaceId, name: "deal.stage.changed",
        entityType: "deal", entityId: A.dealId, payload: "{}",
      },
      select: { id: true },
    });

    // Exactly the overshoot timestamp(3) rounding can produce.
    assert.ok(
      (await dueWithin("0.5 milliseconds", [event.id])).includes(event.id),
      "an event dated half a millisecond ahead — precisely what timestamp(3) rounding does — " +
        "was not claimable, so a just-created event can be skipped by every worker",
    );

    // The control: the grace absorbs the rounding and nothing more.
    assert.ok(
      !(await dueWithin("1 hour", [event.id])).includes(event.id),
      "an event scheduled an hour out was claimed early — the grace is too wide",
    );

    // The rollbacks did their job: no row anywhere is left holding this claim.
    assert.equal(
      await db.domainEvent.count({ where: { claimedBy: "availability-probe" } }),
      0,
      "the probe left events claimed by a worker that does not exist",
    );

    await db.domainEvent.deleteMany({ where: { id: event.id } });
    assert.equal(
      await db.domainEvent.count({ where: { id: event.id } }),
      0,
      "the probe left its own fixture behind",
    );
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

  test("a dead-lettered job is never retried automatically", async () => {
    const { dispatchPendingEvents } = await import("../../src/lib/events");

    await db.domainEvent.deleteMany({ where: { workspaceId: A.workspaceId, processedAt: null } });
    const event = await db.domainEvent.create({
      data: {
        workspaceId: A.workspaceId,
        name: "deal.stage.changed",
        entityType: "deal",
        entityId: A.dealId,
        payload: JSON.stringify({}),
        status: "dead",
        deadAt: new Date(),
        attempts: 5,
      },
    });

    const result = await dispatchPendingEvents();
    assert.equal(result.processed, 0, "a dead job was picked up again");

    const after = await db.domainEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert.equal(after.attempts, 5, "the attempt counter kept climbing");
    assert.ok(after.deadAt, "the job left the dead-letter state on its own");

    await db.domainEvent.delete({ where: { id: event.id } });
  });

  test("a poisoned job dead-letters instead of blocking the queue", async () => {
    // The property that matters: one job that always fails must not stop the
    // jobs behind it from running.
    const { runJobs } = await import("../../src/lib/jobs");
    const { registerJobHandlers } = await import("../../src/lib/jobs/handlers");
    const { registerHandler } = await import("../../src/lib/jobs");
    registerJobHandlers();

    let goodRuns = 0;
    registerHandler("note.created", async () => {
      goodRuns++;
    });
    registerHandler("company.created", async () => {
      throw new Error("this handler always fails");
    });

    await db.domainEvent.deleteMany({ where: { workspaceId: A.workspaceId, processedAt: null } });

    const poison = await db.domainEvent.create({
      data: {
        workspaceId: A.workspaceId, name: "company.created", entityType: "company",
        entityId: A.companyId, payload: "{}", maxAttempts: 2,
      },
    });
    await db.domainEvent.create({
      data: {
        workspaceId: A.workspaceId, name: "note.created", entityType: "note",
        entityId: A.noteId, payload: "{}",
      },
    });

    // Enough passes to exhaust the poisoned job's attempts. Its backoff is
    // cleared between passes so the test does not wait on real time.
    for (let i = 0; i < 3; i++) {
      await runJobs(10);
      await db.domainEvent.updateMany({
        where: { status: "failed" },
        data: { availableAt: new Date(Date.now() - 1000) },
      });
    }

    const dead = await db.domainEvent.findUniqueOrThrow({ where: { id: poison.id } });
    assert.ok(dead.deadAt, "the poisoned job never dead-lettered");
    assert.equal(dead.status, "dead");

    assert.ok(goodRuns > 0, "a healthy job behind a poisoned one never ran");

    // And the failure history is preserved, not just the latest error.
    const runs = await db.jobRun.count({ where: { eventId: poison.id } });
    assert.ok(runs >= 2, "the execution log did not record each attempt");
  });

  test("a claim whose worker died is reclaimable", async () => {
    // Without this, a crash mid-job strands the work permanently.
    const { claimJobs } = await import("../../src/lib/jobs");

    await db.domainEvent.deleteMany({ where: { workspaceId: A.workspaceId, processedAt: null } });
    const stranded = await db.domainEvent.create({
      data: {
        workspaceId: A.workspaceId, name: "note.created", entityType: "note",
        entityId: A.noteId, payload: "{}",
        status: "processing",
        claimedBy: "a-worker-that-died",
        claimedUntil: new Date(Date.now() - 60_000),
      },
    });

    const claimed = await claimJobs(10);
    assert.ok(
      claimed.some((job) => job.id === stranded.id),
      "a job whose claim expired was never reclaimed",
    );

    await db.domainEvent.deleteMany({ where: { id: stranded.id } });
  });

  test("a live claim is not stolen by another worker", async () => {
    const { claimJobs } = await import("../../src/lib/jobs");

    await db.domainEvent.deleteMany({ where: { workspaceId: A.workspaceId, processedAt: null } });
    const held = await db.domainEvent.create({
      data: {
        workspaceId: A.workspaceId, name: "note.created", entityType: "note",
        entityId: A.noteId, payload: "{}",
        status: "processing",
        claimedBy: "a-worker-that-is-alive",
        claimedUntil: new Date(Date.now() + 300_000),
      },
    });

    const claimed = await claimJobs(10);
    assert.ok(
      !claimed.some((job) => job.id === held.id),
      "a job being worked on was claimed by a second worker",
    );

    await db.domainEvent.deleteMany({ where: { id: held.id } });
  });

  test("a failure backs off rather than retrying immediately", async () => {
    const { runJobs, registerHandler } = await import("../../src/lib/jobs");
    const { registerJobHandlers } = await import("../../src/lib/jobs/handlers");
    registerJobHandlers();
    registerHandler("task.created", async () => {
      throw new Error("transient");
    });

    await db.domainEvent.deleteMany({ where: { workspaceId: A.workspaceId, processedAt: null } });
    const job = await db.domainEvent.create({
      data: {
        workspaceId: A.workspaceId, name: "task.created", entityType: "task",
        entityId: A.taskId, payload: "{}",
      },
    });

    const before = Date.now();
    await runJobs(10);

    const after = await db.domainEvent.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(after.status, "failed");
    assert.ok(
      after.availableAt.getTime() > before,
      "a failed job was immediately available again — a hot retry loop",
    );

    await db.domainEvent.deleteMany({ where: { id: job.id } });
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
