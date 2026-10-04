/**
 * The Stripe webhook: the only path that may grant a paid plan.
 *
 * These run against the real route handler, with real signature verification —
 * `constructEventAsync` is pure crypto, so the only thing stubbed is the network.
 * A fake verifier would let every test here pass while the check that protects
 * the endpoint was broken, which is precisely the failure worth catching.
 *
 * The cases that earn their place:
 *
 *   - an unsigned and a wrongly-signed delivery are refused;
 *   - a replayed delivery applies once;
 *   - **out-of-order delivery converges on the truth**, which is the property the
 *     handler is designed around: it re-reads the subscription from Stripe rather
 *     than trusting the payload, so a stale `updated` arriving after a `deleted`
 *     cannot resurrect a cancelled plan;
 *   - a failed payment keeps access while Stripe retries, and a cancellation
 *     removes it;
 *   - an unrecognised price grants nothing rather than guessing a plan.
 *
 * Environment is set before any import, because `src/lib/env.ts` snapshots
 * `process.env` at module load.
 */

const WEBHOOK_SECRET = "whsec_test_secret_for_signature_verification";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy_key_for_tests";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_PRICE_PLUS = "price_test_plus";
process.env.STRIPE_PRICE_PRO = "price_test_pro";

import { test, describe, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

/**
 * Imported inside `before()`, not at the top level.
 *
 * Two constraints meet here: the test harness transpiles to CJS, where top-level
 * await is unavailable; and `src/lib/env.ts` snapshots `process.env` when it is
 * first loaded, so the Stripe variables above must be set before anything pulls
 * it in. A dynamic import in `before()` satisfies both.
 */
let POST: (request: Request) => Promise<Response>;
let setStripeClientForTests: (instance: Stripe | null) => void;

let A: Tenant;
/** Subscriptions the stubbed Stripe will return, by id. */
const subscriptions = new Map<string, unknown>();
let retrieveCalls = 0;

/** A real Stripe instance — only the network methods are replaced. */
function installStub() {
  const stripe = new Stripe("sk_test_dummy_key_for_tests", {
    apiVersion: "2026-09-30.endive",
  });

  // @ts-expect-error -- deliberately replacing one network method.
  stripe.subscriptions.retrieve = async (id: string) => {
    retrieveCalls += 1;
    const found = subscriptions.get(id);
    if (!found) {
      const error = new Error(`No such subscription: ${id}`);
      throw error;
    }
    return found;
  };
  // @ts-expect-error -- deliberately replacing one network method.
  stripe.customers.retrieve = async () => ({ deleted: false, metadata: {}, email: null });

  setStripeClientForTests(stripe);
  return stripe;
}

function subscription(options: {
  id: string;
  status: string;
  priceId: string;
  userId: string;
  customerId: string;
  periodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  cancelAt?: number | null;
  canceledAt?: number | null;
}) {
  return {
    id: options.id,
    object: "subscription",
    status: options.status,
    cancel_at_period_end: options.cancelAtPeriodEnd ?? false,
    cancel_at: options.cancelAt ?? null,
    canceled_at: options.canceledAt ?? null,
    customer: options.customerId,
    metadata: { userId: options.userId },
    items: {
      object: "list",
      data: [
        {
          id: `si_${options.id}`,
          price: { id: options.priceId, object: "price" },
          current_period_end: options.periodEnd ?? Math.floor(Date.now() / 1000) + 30 * 86_400,
        },
      ],
    },
  };
}

/** Builds a signed request exactly as Stripe would send one. */
function signedRequest(event: Record<string, unknown>, options: { secret?: string; signature?: string } = {}) {
  const payload = JSON.stringify(event);
  const header =
    options.signature ??
    Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: options.secret ?? WEBHOOK_SECRET,
    });

  return new Request("https://tinycrm.biz/api/billing/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  });
}

let eventSeq = 0;
function eventFor(type: string, object: unknown, id?: string) {
  eventSeq += 1;
  return {
    id: id ?? `evt_test_${eventSeq}`,
    object: "event",
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  };
}

async function planOf(userId: string) {
  const row = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { plan: true, planStatus: true, billingCustomerId: true },
  });
  return row;
}

describe("Stripe webhook", () => {
  before(async () => {
    ({ POST } = await import("../../src/app/api/billing/stripe/webhook/route"));
    ({ setStripeClientForTests } = await import("../../src/lib/billing/stripe"));
    A = await createTenant("StripeHook");
    installStub();
  });

  after(async () => {
    setStripeClientForTests(null);
    await cleanupTenants([A]);
    await db.$disconnect();
  });

  beforeEach(async () => {
    subscriptions.clear();
    retrieveCalls = 0;
    await db.user.update({
      where: { id: A.ownerId },
      data: { plan: "free", planStatus: "active", billingCustomerId: null, planRenewsAt: null },
    });
    await db.idempotencyKey.deleteMany({ where: { scope: "webhook:stripe" } });
  });

  // --- Verification --------------------------------------------------------

  test("a delivery with no signature is refused", async () => {
    const response = await POST(
      new Request("https://tinycrm.biz/api/billing/stripe/webhook", {
        method: "POST",
        body: JSON.stringify(eventFor("customer.subscription.updated", {})),
      }),
    );
    assert.equal(response.status, 401);
  });

  test("a delivery signed with the wrong secret is refused", async () => {
    const sub = subscription({
      id: "sub_wrong", status: "active", priceId: "price_test_pro",
      userId: A.ownerId, customerId: "cus_wrong",
    });
    subscriptions.set(sub.id, sub);

    const response = await POST(
      signedRequest(eventFor("customer.subscription.created", sub), { secret: "whsec_a_different_secret" }),
    );
    assert.equal(response.status, 401);
    assert.equal((await planOf(A.ownerId)).plan, "free", "nothing may be granted on a bad signature");
  });

  test("a garbage signature header is refused", async () => {
    const response = await POST(
      signedRequest(eventFor("customer.subscription.created", {}), { signature: "t=1,v1=deadbeef" }),
    );
    assert.equal(response.status, 401);
  });

  // --- Granting ------------------------------------------------------------

  test("an active subscription grants the matching plan and stores the customer", async () => {
    const sub = subscription({
      id: "sub_grant", status: "active", priceId: "price_test_pro",
      userId: A.ownerId, customerId: "cus_grant",
    });
    subscriptions.set(sub.id, sub);

    const response = await POST(signedRequest(eventFor("customer.subscription.created", sub)));
    assert.equal(response.status, 200);

    const after = await planOf(A.ownerId);
    assert.equal(after.plan, "pro");
    assert.equal(after.planStatus, "active");
    assert.equal(after.billingCustomerId, "cus_grant", "the customer id is reused on later events");
  });

  test("checkout.session.completed grants from the session's subscription", async () => {
    const sub = subscription({
      id: "sub_checkout", status: "active", priceId: "price_test_plus",
      userId: A.ownerId, customerId: "cus_checkout",
    });
    subscriptions.set(sub.id, sub);

    const session = {
      id: "cs_test_1",
      object: "checkout.session",
      mode: "subscription",
      subscription: sub.id,
      customer: "cus_checkout",
      client_reference_id: A.ownerId,
      metadata: { userId: A.ownerId, plan: "plus" },
    };

    const response = await POST(signedRequest(eventFor("checkout.session.completed", session)));
    assert.equal(response.status, 200);
    assert.equal((await planOf(A.ownerId)).plan, "plus");
  });

  test("the plan comes from Stripe, not from the event payload", async () => {
    // The payload claims Pro; Stripe's copy says Plus. Stripe wins, because a
    // payload is only as trustworthy as whoever assembled it, and the whole
    // design of this handler is that it re-reads.
    const authoritative = subscription({
      id: "sub_mismatch", status: "active", priceId: "price_test_plus",
      userId: A.ownerId, customerId: "cus_mismatch",
    });
    subscriptions.set(authoritative.id, authoritative);

    const lying = { ...authoritative, items: { object: "list", data: [
      { id: "si_lie", price: { id: "price_test_pro", object: "price" }, current_period_end: 0 },
    ] } };

    await POST(signedRequest(eventFor("customer.subscription.updated", lying)));
    assert.equal((await planOf(A.ownerId)).plan, "plus", "the re-read price decides the plan");
  });

  // --- Idempotency ---------------------------------------------------------

  test("a replayed delivery is acknowledged once and applied once", async () => {
    const sub = subscription({
      id: "sub_replay", status: "active", priceId: "price_test_pro",
      userId: A.ownerId, customerId: "cus_replay",
    });
    subscriptions.set(sub.id, sub);
    const event = eventFor("customer.subscription.created", sub, "evt_replayed_once");

    const first = await POST(signedRequest(event));
    const firstBody = await first.json();
    const before = retrieveCalls;

    const second = await POST(signedRequest(event));
    const secondBody = await second.json();

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(firstBody.deduped, undefined, "the first delivery is processed");
    assert.equal(secondBody.deduped, true, "the replay is recognised as one");
    assert.equal(retrieveCalls, before, "a replay does no further work");
    assert.equal((await planOf(A.ownerId)).plan, "pro");
  });

  // --- Ordering ------------------------------------------------------------

  test("OUT OF ORDER: a stale update arriving after a cancellation cannot resurrect the plan", async () => {
    const active = subscription({
      id: "sub_order", status: "active", priceId: "price_test_pro",
      userId: A.ownerId, customerId: "cus_order",
    });
    subscriptions.set(active.id, active);

    // 1. The upgrade is delivered and applied.
    await POST(signedRequest(eventFor("customer.subscription.created", active)));
    assert.equal((await planOf(A.ownerId)).plan, "pro");

    // 2. The customer cancels. Stripe's copy is now canceled.
    subscriptions.set(active.id, { ...active, status: "canceled" });
    await POST(signedRequest(eventFor("customer.subscription.deleted", { ...active, status: "canceled" })));
    assert.equal((await planOf(A.ownerId)).plan, "free", "a cancellation removes access");

    // 3. The *older* update event is now delivered late, still claiming active.
    //    Trusting the payload would re-grant Pro to a cancelled customer. The
    //    re-read is what makes this harmless.
    const stale = eventFor("customer.subscription.updated", { ...active, status: "active" });
    const response = await POST(signedRequest(stale));

    assert.equal(response.status, 200);
    assert.equal(
      (await planOf(A.ownerId)).plan,
      "free",
      "a stale event must not resurrect a cancelled subscription",
    );
  });

  test("events delivered in reverse order reach the same state as forward order", async () => {
    const sub = subscription({
      id: "sub_converge", status: "active", priceId: "price_test_plus",
      userId: A.ownerId, customerId: "cus_converge",
    });
    subscriptions.set(sub.id, sub);

    // Deliver `updated` before `created` — a legal Stripe ordering.
    await POST(signedRequest(eventFor("customer.subscription.updated", sub)));
    await POST(signedRequest(eventFor("customer.subscription.created", sub)));

    assert.equal((await planOf(A.ownerId)).plan, "plus");
    assert.equal((await planOf(A.ownerId)).planStatus, "active");
  });

  // --- Payment failure and recovery ---------------------------------------

  test("a failed payment keeps access and marks the account past due", async () => {
    const sub = subscription({
      id: "sub_pastdue", status: "active", priceId: "price_test_pro",
      userId: A.ownerId, customerId: "cus_pastdue",
    });
    subscriptions.set(sub.id, sub);
    await POST(signedRequest(eventFor("customer.subscription.created", sub)));
    assert.equal((await planOf(A.ownerId)).plan, "pro");

    // Stripe is retrying the card.
    subscriptions.set(sub.id, { ...sub, status: "past_due" });
    const invoice = {
      id: "in_test_1",
      object: "invoice",
      subscription: sub.id,
      customer: "cus_pastdue",
    };
    await POST(signedRequest(eventFor("invoice.payment_failed", invoice)));

    const after = await planOf(A.ownerId);
    assert.equal(after.plan, "pro", "access is kept while Stripe retries — an expired card is not a cancellation");
    assert.equal(after.planStatus, "past_due", "but the state is recorded so the UI can warn");
  });

  test("a recovered payment clears past due", async () => {
    const sub = subscription({
      id: "sub_recover", status: "past_due", priceId: "price_test_pro",
      userId: A.ownerId, customerId: "cus_recover",
    });
    subscriptions.set(sub.id, sub);
    await POST(signedRequest(eventFor("invoice.payment_failed", { id: "in_a", object: "invoice", subscription: sub.id })));
    assert.equal((await planOf(A.ownerId)).planStatus, "past_due");

    subscriptions.set(sub.id, { ...sub, status: "active" });
    await POST(signedRequest(eventFor("invoice.paid", { id: "in_b", object: "invoice", subscription: sub.id })));

    const after = await planOf(A.ownerId);
    assert.equal(after.plan, "pro");
    assert.equal(after.planStatus, "active");
  });

  test("an unpaid subscription loses access", async () => {
    const sub = subscription({
      id: "sub_unpaid", status: "active", priceId: "price_test_pro",
      userId: A.ownerId, customerId: "cus_unpaid",
    });
    subscriptions.set(sub.id, sub);
    await POST(signedRequest(eventFor("customer.subscription.created", sub)));

    subscriptions.set(sub.id, { ...sub, status: "unpaid" });
    await POST(signedRequest(eventFor("customer.subscription.updated", { ...sub, status: "unpaid" })));

    assert.equal((await planOf(A.ownerId)).plan, "free", "Stripe has given up; access ends");
  });


  // --- A cancellation that has not taken effect yet ------------------------

  test("a scheduled cancellation keeps the plan and is distinguishable from an ordinary active one", async () => {
    // Stripe reports this as `active` with `cancel_at_period_end: true`: the
    // customer has cancelled but paid for the rest of the period, so access
    // continues. Reading only `status` made it identical to an ordinary active
    // subscription, which had two costs — the billing page told a cancelling
    // customer their plan "renews" on the date it would actually end, and a
    // scheduled cancellation could not be verified from stored data at all.
    const sub = subscription({
      id: "sub_sched", status: "active", priceId: "price_test_plus",
      userId: A.ownerId, customerId: "cus_sched", cancelAtPeriodEnd: true,
    });
    subscriptions.set(sub.id, sub);

    await POST(signedRequest(eventFor("customer.subscription.updated", sub)));

    const after = await planOf(A.ownerId);
    assert.equal(after.plan, "plus", "paid-for time is kept — a cancellation is not an eviction");
    assert.equal(
      after.planStatus,
      "canceling",
      "and the state is recorded, so the UI can say 'ends' rather than 'renews'",
    );
  });

  test("clearing a scheduled cancellation returns the plan to ordinary active", async () => {
    const sub = subscription({
      id: "sub_resume", status: "active", priceId: "price_test_plus",
      userId: A.ownerId, customerId: "cus_resume", cancelAtPeriodEnd: true,
    });
    subscriptions.set(sub.id, sub);
    await POST(signedRequest(eventFor("customer.subscription.updated", sub)));
    assert.equal((await planOf(A.ownerId)).planStatus, "canceling");

    // The customer changes their mind in the portal.
    subscriptions.set(sub.id, { ...sub, cancel_at_period_end: false });
    await POST(signedRequest(eventFor("customer.subscription.updated", { ...sub, cancel_at_period_end: false })));

    const after = await planOf(A.ownerId);
    assert.equal(after.plan, "plus");
    assert.equal(after.planStatus, "active", "resuming is not a one-way door");
  });

  test("the period end is stored, because it is what the cancellation notice shows", async () => {
    const endsAt = Math.floor(Date.now() / 1000) + 10 * 86_400;
    const sub = subscription({
      id: "sub_ends", status: "active", priceId: "price_test_plus",
      userId: A.ownerId, customerId: "cus_ends", cancelAtPeriodEnd: true, periodEnd: endsAt,
    });
    subscriptions.set(sub.id, sub);

    await POST(signedRequest(eventFor("customer.subscription.updated", sub)));

    const row = await db.user.findUniqueOrThrow({
      where: { id: A.ownerId },
      select: { planRenewsAt: true },
    });
    assert.ok(row.planRenewsAt, "a date is stored");
    assert.equal(
      Math.floor(row.planRenewsAt!.getTime() / 1000),
      endsAt,
      "and it is the period end Stripe reported, which is the date access actually ends",
    );
  });


  test("CURRENT REPRESENTATION: a future cancel_at is a scheduled cancellation even with cancel_at_period_end false", async () => {
    // The exact state a sandbox Customer Portal cancellation produced:
    //   status                 active
    //   cancel_at_period_end   false      <- the legacy flag is NOT set
    //   cancel_at              one month out
    //   canceled_at            minutes ago
    //
    // Checking only `cancel_at_period_end` concluded that nothing had been
    // cancelled, which is the bug this test pins. Stripe has two representations
    // of "cancelled but still paid up" and this is the current one.
    const endsAt = Math.floor(Date.now() / 1000) + 31 * 86_400;
    const sub = subscription({
      id: "sub_cancelat", status: "active", priceId: "price_test_plus",
      userId: A.ownerId, customerId: "cus_cancelat",
      cancelAtPeriodEnd: false,
      cancelAt: endsAt,
      canceledAt: Math.floor(Date.now() / 1000) - 240,
    });
    subscriptions.set(sub.id, sub);

    await POST(signedRequest(eventFor("customer.subscription.updated", sub)));

    const after = await db.user.findUniqueOrThrow({
      where: { id: A.ownerId },
      select: { plan: true, planStatus: true, planRenewsAt: true },
    });

    assert.equal(after.plan, "plus", "the paid period is kept — access must not end early");
    assert.equal(after.planStatus, "canceling", "and it is recognised as a scheduled cancellation");
    assert.equal(
      Math.floor(after.planRenewsAt!.getTime() / 1000),
      endsAt,
      "the stored date is cancel_at — the instant access actually ends",
    );
  });

  test("the stored date is cancel_at, not the period end, when the two differ", async () => {
    // A cancellation can be scheduled for a date that is not the period end, and
    // the notice must name the date access ends rather than the one it would have
    // renewed on. Asserting they differ is what stops `periodEndOf` being used by
    // accident.
    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86_400;
    const cancelAt = Math.floor(Date.now() / 1000) + 10 * 86_400;
    const sub = subscription({
      id: "sub_earlyend", status: "active", priceId: "price_test_pro",
      userId: A.ownerId, customerId: "cus_earlyend",
      periodEnd, cancelAt,
    });
    subscriptions.set(sub.id, sub);

    await POST(signedRequest(eventFor("customer.subscription.updated", sub)));

    const after = await db.user.findUniqueOrThrow({
      where: { id: A.ownerId },
      select: { planStatus: true, planRenewsAt: true },
    });
    assert.equal(after.planStatus, "canceling");
    assert.equal(Math.floor(after.planRenewsAt!.getTime() / 1000), cancelAt);
    assert.notEqual(Math.floor(after.planRenewsAt!.getTime() / 1000), periodEnd);
  });

  test("a cancel_at in the past on an active subscription is ignored", async () => {
    // Stripe would have moved the status to `canceled`, so a past timestamp is not
    // a pending end. Treating it as one would revoke a plan that is live.
    const sub = subscription({
      id: "sub_pastcancel", status: "active", priceId: "price_test_plus",
      userId: A.ownerId, customerId: "cus_pastcancel",
      cancelAt: Math.floor(Date.now() / 1000) - 86_400,
    });
    subscriptions.set(sub.id, sub);

    await POST(signedRequest(eventFor("customer.subscription.updated", sub)));

    const after = await planOf(A.ownerId);
    assert.equal(after.plan, "plus");
    assert.equal(after.planStatus, "active", "not 'canceling' — there is no pending end");
  });

  test("a stale canceled_at alone does not mark an account as cancelling", async () => {
    // canceled_at records when a cancellation was *requested*, and a subscription
    // that was scheduled and then resumed can still carry one. The question is
    // whether an end is still coming, which only cancel_at answers.
    const sub = subscription({
      id: "sub_resumed", status: "active", priceId: "price_test_plus",
      userId: A.ownerId, customerId: "cus_resumed",
      cancelAt: null, cancelAtPeriodEnd: false,
      canceledAt: Math.floor(Date.now() / 1000) - 3_600,
    });
    subscriptions.set(sub.id, sub);

    await POST(signedRequest(eventFor("customer.subscription.updated", sub)));

    const after = await planOf(A.ownerId);
    assert.equal(after.planStatus, "active", "resumed subscriptions are ordinary active ones");
  });


  test("a cancellation clears the renewal date rather than leaving a stale one", async () => {
    // A canceled subscription still reports a period end, so the naive thing is to
    // store it — leaving a Free account with a renewal date for a subscription that
    // no longer exists. The billing page happens not to show it, which is exactly
    // why it would survive unnoticed until something else read it.
    const sub = subscription({
      id: "sub_clear", status: "active", priceId: "price_test_plus",
      userId: A.ownerId, customerId: "cus_clear",
    });
    subscriptions.set(sub.id, sub);
    await POST(signedRequest(eventFor("customer.subscription.created", sub)));

    const whilePaid = await db.user.findUniqueOrThrow({
      where: { id: A.ownerId }, select: { planRenewsAt: true },
    });
    assert.ok(whilePaid.planRenewsAt, "a paid plan stores its renewal date");

    subscriptions.set(sub.id, { ...sub, status: "canceled" });
    await POST(signedRequest(eventFor("customer.subscription.deleted", { ...sub, status: "canceled" })));

    const after = await db.user.findUniqueOrThrow({
      where: { id: A.ownerId }, select: { plan: true, planRenewsAt: true },
    });
    assert.equal(after.plan, "free");
    assert.equal(after.planRenewsAt, null, "and Free carries no renewal date");
  });

  // --- Refusals ------------------------------------------------------------

  test("an unrecognised price grants nothing", async () => {
    const sub = subscription({
      id: "sub_unknown_price", status: "active", priceId: "price_from_another_account",
      userId: A.ownerId, customerId: "cus_unknown",
    });
    subscriptions.set(sub.id, sub);

    const response = await POST(signedRequest(eventFor("customer.subscription.created", sub)));
    const body = await response.json();

    assert.equal(response.status, 200, "acknowledged so Stripe stops retrying");
    assert.equal(body.outcome, "unrecognised_price");
    assert.equal((await planOf(A.ownerId)).plan, "free", "a guessed plan is worse than none");
  });

  test("an event for an unknown account is acknowledged, not retried forever", async () => {
    const sub = subscription({
      id: "sub_ghost", status: "active", priceId: "price_test_pro",
      userId: "user-that-does-not-exist", customerId: "cus_ghost",
    });
    subscriptions.set(sub.id, sub);

    const response = await POST(signedRequest(eventFor("customer.subscription.created", sub)));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.outcome, "unknown_account");
  });

  test("a subscription Stripe cannot produce grants nothing", async () => {
    const sub = subscription({
      id: "sub_missing", status: "active", priceId: "price_test_pro",
      userId: A.ownerId, customerId: "cus_missing",
    });
    // Deliberately not registered, so retrieve throws.
    const response = await POST(signedRequest(eventFor("customer.subscription.created", sub)));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.outcome, "subscription_unreadable");
    assert.equal((await planOf(A.ownerId)).plan, "free");
  });

  test("an unhandled event type is acknowledged and does nothing", async () => {
    const response = await POST(signedRequest(eventFor("customer.created", { id: "cus_x" })));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ignored, "unhandled_type");
    assert.equal(retrieveCalls, 0, "an unhandled type must not cost a Stripe API call");
  });
});

describe("only a verified webhook can move a plan", () => {
  /**
   * The invariant, asserted against the source rather than against behaviour.
   *
   * Behaviour tests can only prove that the paths they know about do not grant a
   * plan. This proves that no *other* path exists — which is the actual property,
   * and the one that decays as the codebase grows. It matters more now than it
   * did: there is a billing action module that the browser can reach, and the
   * difference between it and the webhook is that it returns a Stripe URL and
   * never touches an entitlement.
   *
   * The historical failure (audit finding F-04) was a `changePlan` server action
   * that let any user assign themselves the top plan from the browser.
   */
  const ALLOWED = new Set([
    "src/lib/entitlements.ts", // defines it
    "src/app/api/billing/webhook/route.ts", // the generic signed webhook
    "src/app/api/billing/stripe/webhook/route.ts", // the Stripe webhook
  ]);

  test("applyPlanChange is referenced only where it is defined and by the webhooks", () => {
    const root = resolve(import.meta.dirname, "../..");
    const found = execFileSync(
      "grep",
      ["-rl", "applyPlanChange", "src", "--include=*.ts", "--include=*.tsx"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .sort();

    for (const file of found) {
      assert.ok(
        ALLOWED.has(file),
        `${file} references applyPlanChange. Entitlements may only move on a verified ` +
          `server-to-server call — add a reviewed entry here only if that is what this is.`,
      );
    }
    // The webhooks must still be among them, so this cannot pass by the function
    // having been deleted.
    assert.ok(found.includes("src/app/api/billing/stripe/webhook/route.ts"));
  });

  test("no server action module grants a plan", () => {
    const root = resolve(import.meta.dirname, "../..");
    const actions = execFileSync("grep", ["-rl", '"use server"', "src/lib/actions"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);

    assert.ok(actions.length > 0, "there are server action modules to check");
    for (const file of actions) {
      const text = readFileSync(resolve(root, file), "utf8");
      // `applyPlanChange` is the only writer, and `planStatus` / `planRenewsAt`
      // are billing-only columns — their appearance in a browser-reachable module
      // is the smell. A bare `plan:` is deliberately NOT checked: the checkout
      // action legitimately passes a plan id to Stripe, and flagging that would
      // make this test noise rather than a control.
      for (const forbidden of ["applyPlanChange", "planStatus", "planRenewsAt", "billingCustomerId"]) {
        assert.ok(
          !text.includes(forbidden),
          `${file} is browser-reachable and touches \`${forbidden}\` — billing state moves only by webhook`,
        );
      }
    }
  });
});
