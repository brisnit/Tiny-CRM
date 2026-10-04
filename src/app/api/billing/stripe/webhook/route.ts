import { NextResponse } from "next/server";
import type Stripe from "stripe";

import { recordAudit } from "@/lib/audit";
import { claimWebhookEvent } from "@/lib/billing/webhook";
import {
  entitlementFor, periodEndOf, planForPrice, priceIdOf, scheduledCancellationAt, stripeClient,
} from "@/lib/billing/stripe";
import { db } from "@/lib/db";
import { applyPlanChange } from "@/lib/entitlements";
import { env, stripeConfigured, stripeMode } from "@/lib/env";
import { AppError, toAppError } from "@/lib/errors";
import { log, newRequestId, runWithContext } from "@/lib/logger";
import { clientAddress, enforceRateLimit } from "@/lib/rate-limit";
import type { PlanId } from "@/lib/plans";

/**
 * The Stripe webhook. The only path in the application that may grant a paid
 * plan.
 *
 * ## Why entitlements are re-read instead of taken from the event
 *
 * Stripe does not guarantee delivery order. `customer.subscription.updated` for
 * an upgrade can arrive after the `deleted` event that followed it, and a
 * redelivery of a week-old event can arrive at any time. Applying the payload of
 * whatever event arrives last therefore applies a *random* one of the states the
 * subscription has been in.
 *
 * A timestamp watermark is the usual fix, and it needs a new column plus a
 * correct comparison on every path. This handler takes the simpler and stronger
 * route: for every subscription-bearing event it **re-reads the subscription from
 * Stripe** and applies that. Stripe's copy is authoritative by definition, so
 * order stops mattering — any event, in any order, converges on the same truth,
 * and a replayed event is a no-op rather than a regression. The cost is one API
 * call per webhook.
 *
 * ## The four checks, inherited from src/lib/billing/webhook.ts
 *
 *   1. **Signature** — `constructEventAsync` over the raw body. A payload that
 *      merely reached the endpoint proves nothing, and the body must be the
 *      untouched bytes, which is why it is read with `request.text()` and never
 *      parsed first.
 *   2. **Timestamp** — enforced inside `constructEventAsync` by its tolerance
 *      argument, so a captured request cannot be replayed later.
 *   3. **Idempotency** — the event id is claimed once in the database. Combined
 *      with the re-read above this is belt and braces, which is the right amount
 *      for the one endpoint that hands out paid access.
 *   4. **Structured logging** — every outcome, with no card data and no email.
 *
 * ## Why unknown accounts return 200
 *
 * A 500 makes Stripe retry for days. If the account genuinely no longer exists,
 * every one of those retries fails identically and buries real failures in the
 * dashboard. The event is acknowledged and logged as ignored instead.
 */

export const dynamic = "force-dynamic";

/** Events that change what an account is entitled to. */
const HANDLED = new Set<Stripe.Event["type"]>([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

/** Stripe's documented replay window, in seconds. */
const TOLERANCE_SECONDS = 300;

export async function POST(request: Request) {
  const requestId = newRequestId();

  return runWithContext({ requestId, route: "billing.stripe.webhook" }, async () => {
    try {
      if (!stripeConfigured()) {
        // Nothing can be verified without the signing secret, so nothing may be
        // trusted. 503 rather than 200: this is our misconfiguration, and a
        // retry after it is fixed is exactly what should happen.
        log.error("stripe webhook received while unconfigured", {});
        throw new AppError("internal", "Stripe is not configured for this deployment.");
      }

      await enforceRateLimit("webhook", { ip: clientAddress(request.headers) });

      const signature = request.headers.get("stripe-signature");
      if (!signature) throw new AppError("unauthorized", "Missing signature.");

      // Raw bytes. Parsing before verifying would verify a re-serialisation of
      // the payload rather than the payload.
      const body = await request.text();

      const stripe = stripeClient();
      let event: Stripe.Event;
      try {
        event = await stripe.webhooks.constructEventAsync(
          body,
          signature,
          env.stripeWebhookSecret!,
          TOLERANCE_SECONDS,
        );
      } catch (error) {
        log.warn("stripe webhook signature rejected", {
          reason: error instanceof Error ? error.message : "unknown",
        });
        throw new AppError("unauthorized", "Signature verification failed.");
      }

      if (!HANDLED.has(event.type)) {
        // Acknowledged, not processed. Stripe sends whatever the endpoint is
        // subscribed to, and an unhandled type is not an error.
        return NextResponse.json({ ok: true, ignored: "unhandled_type" });
      }

      const fresh = await claimWebhookEvent("stripe", event.id);
      if (!fresh) {
        log.info("stripe webhook redelivery ignored", { type: event.type });
        return NextResponse.json(
          { ok: true, deduped: true },
          { headers: { "x-request-id": requestId } },
        );
      }

      const outcome = await applyEvent(event);

      log.info("stripe webhook applied", {
        type: event.type,
        outcome: outcome.outcome,
        subscriptionId: outcome.subscriptionId,
        mode: stripeMode(),
      });

      return NextResponse.json(
        { ok: true, ...outcome },
        { headers: { "x-request-id": requestId } },
      );
    } catch (raw) {
      const error = raw instanceof AppError ? raw : toAppError(raw);
      if (error.category === "internal") {
        log.error("stripe webhook failed", { error: String(error.internal) });
      } else {
        log.warn("stripe webhook rejected", { category: error.category });
      }
      return NextResponse.json(
        { ok: false, error: error.message, requestId },
        { status: error.status, headers: { "x-request-id": requestId } },
      );
    }
  });
}

type Outcome = { outcome: string; plan?: PlanId; status?: string; subscriptionId?: string };

/** Finds the subscription id an event refers to, whatever shape it arrives in. */
function subscriptionIdFrom(event: Stripe.Event): string | null {
  // `event.data.object` is a union of every Stripe object, so it is narrowed
  // through `unknown` per event type below rather than asserted across the union.
  const object = event.data.object as unknown as Record<string, unknown>;

  switch (event.type) {
    case "checkout.session.completed": {
      const session = object as unknown as Stripe.Checkout.Session;
      return typeof session.subscription === "string"
        ? session.subscription
        : (session.subscription?.id ?? null);
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return (object as unknown as Stripe.Subscription).id ?? null;
    case "invoice.paid":
    case "invoice.payment_failed": {
      // An invoice references its subscription through the line items in current
      // API versions; the top-level field is the older shape. Both are checked
      // because which one is populated depends on the pinned API version, and
      // reading only one silently yields null on the other.
      const invoice = object as unknown as Stripe.Invoice & {
        subscription?: string | { id: string } | null;
      };
      const direct = invoice.subscription;
      if (typeof direct === "string") return direct;
      if (direct && typeof direct === "object") return direct.id;
      for (const line of invoice.lines?.data ?? []) {
        const parent = (line as unknown as {
          parent?: { subscription_item_details?: { subscription?: string } };
        }).parent;
        const id = parent?.subscription_item_details?.subscription;
        if (id) return id;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Resolves the account an event belongs to, strongest signal first.
 *
 * The user id carried in metadata is preferred over everything else because this
 * application put it there. The stored customer id is next. Email is last and
 * only as a repair path for a subscription created outside this flow — it is
 * mutable, case-variable, and two customers can share one, so it is never used
 * when an id is available.
 */
async function resolveUserId(
  subscription: Stripe.Subscription | null,
  event: Stripe.Event,
): Promise<string | null> {
  const fromMetadata =
    subscription?.metadata?.userId ??
    ((event.data.object as unknown as Record<string, unknown>).client_reference_id as string | undefined) ??
    ((event.data.object as unknown as Record<string, unknown>).metadata as
      | Record<string, string>
      | undefined)?.userId;

  if (fromMetadata) {
    const user = await db.user.findUnique({ where: { id: fromMetadata }, select: { id: true } });
    if (user) return user.id;
  }

  const customerId =
    typeof subscription?.customer === "string"
      ? subscription.customer
      : (subscription?.customer?.id ??
        ((event.data.object as unknown as Record<string, unknown>).customer as string | undefined));

  if (customerId) {
    const byCustomer = await db.user.findFirst({
      where: { billingCustomerId: customerId },
      select: { id: true },
    });
    if (byCustomer) return byCustomer.id;

    // Repair path: a customer that exists in Stripe with our metadata but is not
    // yet linked here, because a crash landed between creating it and storing it.
    const customer = await stripeClient().customers.retrieve(customerId);
    if (!customer.deleted) {
      const metaUser = customer.metadata?.userId;
      if (metaUser) {
        const user = await db.user.findUnique({ where: { id: metaUser }, select: { id: true } });
        if (user) return user.id;
      }
      if (customer.email) {
        const byEmail = await db.user.findUnique({
          where: { email: customer.email.toLowerCase() },
          select: { id: true },
        });
        if (byEmail) return byEmail.id;
      }
    }
  }

  return null;
}

async function applyEvent(event: Stripe.Event): Promise<Outcome> {
  const subscriptionId = subscriptionIdFrom(event);

  if (!subscriptionId) {
    // A one-off invoice or a non-subscription checkout. Nothing to entitle.
    return { outcome: "no_subscription" };
  }

  const stripe = stripeClient();

  // The authoritative read. This is what makes delivery order irrelevant.
  let subscription: Stripe.Subscription;
  try {
    subscription = await stripe.subscriptions.retrieve(subscriptionId);
  } catch (error) {
    // A subscription Stripe cannot produce is one we must not entitle from.
    log.warn("stripe subscription unreadable", {
      type: event.type,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return { outcome: "subscription_unreadable", subscriptionId };
  }

  const userId = await resolveUserId(subscription, event);
  if (!userId) {
    log.warn("stripe webhook for unknown account", { type: event.type, subscriptionId });
    return { outcome: "unknown_account", subscriptionId };
  }

  const priceId = priceIdOf(subscription);
  const pricedPlan = planForPrice(priceId);

  if (!pricedPlan && subscription.status !== "canceled") {
    // An active subscription on a price this deployment does not know about.
    // Granting a guessed plan would be worse than granting none, and the
    // mismatch is almost always a live price reaching a test deployment or a
    // price created in the dashboard and never put in the environment.
    log.error("stripe subscription on an unrecognised price", {
      status: subscription.status,
      subscriptionId: subscription.id,
      // The price the deployment does not know about. Logging it is the
      // difference between "an upgrade silently did nothing" and a one-line
      // diagnosis, and it is the exact value that belongs in STRIPE_PRICE_*.
      priceId,
      mode: stripeMode(),
    });
    return { outcome: "unrecognised_price", subscriptionId: subscription.id };
  }

  // Derived once and used twice: it decides both the stored status and the date
  // the UI shows. When a cancellation is scheduled, the date that matters is when
  // access *ends*, not when the period would have renewed — they coincide for a
  // cancel-at-period-end, and must not be assumed to.
  const cancelsAt = scheduledCancellationAt(subscription);
  const { plan, status } = entitlementFor(subscription.status, pricedPlan, cancelsAt);

  const before = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { plan: true, planStatus: true },
  });

  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

  await applyPlanChange(userId, plan, {
    status,
    // Cleared when the outcome is Free. A cancelled subscription still reports a
    // period end, so storing it left a free account carrying a renewal date for a
    // subscription that no longer exists — invisible on the billing page, which
    // branches on the price before reading the date, but exactly the kind of stale
    // value that later gets read without that check and shown to someone.
    renewsAt: plan === "free" ? null : (cancelsAt ?? periodEndOf(subscription)),
    customerId,
  });

  // Audited even when nothing changed, because "Stripe told us this and we
  // agreed with what we already had" is the record that makes a billing dispute
  // answerable.
  await recordAudit({
    actorId: null,
    actorEmail: "stripe-webhook",
    action: "billing.plan_changed",
    entityType: "user",
    entityId: userId,
    summary:
      before.plan === plan && before.planStatus === status
        ? `Stripe confirmed ${plan} (${status}); no change`
        : `Plan ${before.plan} (${before.planStatus}) -> ${plan} (${status}) by ${event.type}`,
    metadata: {
      eventId: event.id,
      type: event.type,
      from: before.plan,
      fromStatus: before.planStatus,
      to: plan,
      toStatus: status,
      // The subscription and price this entitlement was derived from. Neither is
      // a secret — they are opaque Stripe identifiers — and recording them is
      // what makes a billing question answerable later: "which subscription
      // granted this plan, and on what price". Their absence turned a
      // two-minute diagnosis into a search, because only the customer id was
      // stored and the subscription is re-read per event rather than kept.
      subscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      cancelsAt: cancelsAt?.toISOString() ?? null,
      priceId: priceId ?? null,
      mode: stripeMode(),
    },
  });

  return { outcome: "applied", plan, status, subscriptionId: subscription.id };
}
