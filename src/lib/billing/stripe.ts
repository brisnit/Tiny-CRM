import "server-only";

import Stripe from "stripe";

import { db } from "@/lib/db";
import { env, stripeConfigured, stripeMode } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { PLANS, type PlanId } from "@/lib/plans";

/**
 * Stripe, server-side only.
 *
 * ## What is and is not here
 *
 * Checkout and the Customer Portal are both **server-created redirects**: this
 * module asks Stripe for a URL and the browser is sent to it. There is therefore
 * no publishable key, no Stripe.js, and nothing Stripe-related in the client
 * bundle — which tests/security/client-bundle.test.ts asserts rather than
 * assumes. Card details never touch this application.
 *
 * ## Entitlements come from Stripe, never from a redirect
 *
 * The success URL is a navigation, and a navigation is something a user can type.
 * Nothing in this module grants a plan; only the verified webhook does, by way of
 * `syncSubscription`, which re-reads the subscription from Stripe rather than
 * trusting the event payload. See the webhook route for why that also solves
 * out-of-order delivery.
 *
 * ## Which account is being billed
 *
 * Billing is per account (`User.plan`), so every function here takes a user id
 * that the caller got from the session — never from a request parameter. A
 * customer cannot reach another account's billing because there is no argument
 * through which they could name one.
 */

let client: Stripe | null = null;
let installedForTests: Stripe | null = null;

/**
 * Installs a Stripe instance for tests.
 *
 * Deliberately narrow. Tests install a real `Stripe` object built with a dummy
 * test key and stub only the two network methods the webhook calls
 * (`subscriptions.retrieve`, `customers.retrieve`). Signature verification is
 * therefore the **real** `constructEventAsync` — pure crypto, no network — so the
 * tests exercise the check that actually protects the endpoint rather than a
 * stand-in for it. A fake client with a fake verifier would let a test pass while
 * the signature check was broken, which is the one failure mode worth catching
 * here.
 *
 * Kept separate from `client` so installing a test double cannot be mistaken for
 * the memoised production client, and so clearing it restores production
 * behaviour exactly.
 */
export function setStripeClientForTests(instance: Stripe | null): void {
  installedForTests = instance;
}

export function stripeClient(): Stripe {
  if (installedForTests) return installedForTests;
  if (!stripeConfigured()) {
    throw new AppError("internal", "Stripe is not configured for this deployment.");
  }
  if (!client) {
    client = new Stripe(env.stripeSecretKey!, {
      // Pinned deliberately. An unpinned version means Stripe can change the
      // shape of a webhook payload under a running deployment, and the thing
      // that would break is entitlement granting.
      apiVersion: "2026-09-30.endive",
      // One retry, matching the AI providers: enough for a transient network
      // fault, not enough to turn a slow request into four.
      maxNetworkRetries: 1,
      timeout: 20_000,
      appInfo: { name: "Tiny CRM", url: "https://tinycrm.biz" },
    });
  }
  return client;
}

/** The plans that can be bought with a Stripe price, and the env var holding it. */
const PRICE_ENV: Partial<Record<PlanId, () => string | undefined>> = {
  plus: () => env.stripePricePlus,
  pro: () => env.stripePricePro,
};

export function priceIdFor(plan: PlanId): string {
  const read = PRICE_ENV[plan];
  if (!read) {
    throw new AppError("validation", `The ${plan} plan is not sold through Stripe.`);
  }
  const priceId = read();
  if (!priceId) {
    throw new AppError(
      "internal",
      `No Stripe price is configured for the ${plan} plan. Set STRIPE_PRICE_${plan.toUpperCase()}.`,
    );
  }
  return priceId;
}

/**
 * Maps a Stripe price back to a plan.
 *
 * Returns null for a price this deployment does not recognise, which is a real
 * case worth distinguishing: a price created in the dashboard and never wired
 * into the environment, or a live-mode price arriving at a test-mode deployment.
 * Granting a guessed plan would be worse than granting none.
 */
export function planForPrice(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  for (const [plan, read] of Object.entries(PRICE_ENV) as [PlanId, () => string | undefined][]) {
    if (read() === priceId) return plan;
  }
  return null;
}

/**
 * The Stripe customer for an account, created once and reused.
 *
 * Reuse matters for more than tidiness: a second customer for the same person
 * splits their invoice history and makes the Customer Portal show only half of
 * it. The id is written back to `User.billingCustomerId` immediately, so a
 * crash between creating and storing is the only way to orphan one — and the
 * idempotency key below makes even that recoverable, because the retry returns
 * the same customer instead of making another.
 */
export async function resolveCustomerId(userId: string): Promise<string> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, email: true, name: true, billingCustomerId: true },
  });

  if (user.billingCustomerId) return user.billingCustomerId;

  const stripe = stripeClient();
  const customer = await stripe.customers.create(
    {
      email: user.email,
      name: user.name,
      // The account this customer belongs to, carried on the customer itself so
      // a webhook that has only a customer id can still resolve an account.
      metadata: { userId: user.id },
    },
    { idempotencyKey: `customer:${user.id}` },
  );

  await db.user.update({ where: { id: user.id }, data: { billingCustomerId: customer.id } });
  log.info("stripe customer created", { mode: stripeMode() });
  return customer.id;
}

/**
 * A Checkout session for one account and one plan.
 *
 * `client_reference_id` and the subscription metadata both carry the user id, so
 * every downstream event can name the account without an email lookup. Email is
 * a poor key here: it is mutable, it is case-variable, and two Stripe customers
 * can share one.
 */
export async function createCheckoutSession(input: {
  userId: string;
  plan: PlanId;
  successUrl: string;
  cancelUrl: string;
}): Promise<string> {
  const plan = PLANS[input.plan];
  if (!plan?.purchasable) {
    throw new AppError("validation", "That plan is not available.");
  }

  const stripe = stripeClient();
  const customerId = await resolveCustomerId(input.userId);
  const priceId = priceIdFor(input.plan);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: input.userId,
    // Mirrored onto the subscription so `customer.subscription.*` events — which
    // carry no session — can still resolve the account.
    subscription_data: { metadata: { userId: input.userId, plan: input.plan } },
    metadata: { userId: input.userId, plan: input.plan },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    // Lets an existing customer correct their address at checkout rather than
    // being stuck with whatever was captured first.
    billing_address_collection: "auto",
    allow_promotion_codes: true,
  });

  if (!session.url) {
    throw new AppError("internal", "Stripe did not return a checkout URL.");
  }

  log.info("stripe checkout session created", { plan: input.plan, mode: stripeMode() });
  return session.url;
}

/**
 * A Customer Portal session: payment methods, invoices, plan changes,
 * cancellation.
 *
 * Deliberately the whole of subscription self-service. Rebuilding any of it in
 * the application would mean a second implementation of upgrade, downgrade,
 * proration and dunning that has to agree with Stripe's — and the consequence of
 * disagreement is a customer charged the wrong amount.
 */
export async function createPortalSession(input: {
  userId: string;
  returnUrl: string;
}): Promise<string> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { billingCustomerId: true },
  });

  if (!user.billingCustomerId) {
    throw new AppError(
      "validation",
      "There is no billing account to manage yet. Start a subscription first.",
    );
  }

  const stripe = stripeClient();
  const session = await stripe.billingPortal.sessions.create({
    customer: user.billingCustomerId,
    return_url: input.returnUrl,
  });

  log.info("stripe portal session created", { mode: stripeMode() });
  return session.url;
}

/**
 * What a Stripe subscription status means for access.
 *
 * `past_due` deliberately keeps the plan. Stripe is still retrying the card, the
 * customer usually does not know yet, and removing their workspaces mid-dunning
 * punishes an expired card like a cancellation. Access ends when Stripe gives up
 * — `canceled` or `unpaid` — which is the point at which the subscription really
 * is over.
 *
 * `incomplete` is the opposite case: a subscription whose first payment never
 * succeeded was never paid for, so it grants nothing.
 */
export function entitlementFor(
  status: Stripe.Subscription.Status,
  plan: PlanId | null,
  /**
   * When access ends because a cancellation is already scheduled, or null.
   *
   * Derived by `scheduledCancellationAt`, which reads more than one field —
   * see there for why a boolean was not enough.
   *
   * A scheduled cancellation keeps the plan: Stripe reports the subscription as
   * `active` because the period is paid for, and taking access away early would
   * be taking something the customer already bought. Only the *label* changes, so
   * the UI can say "ends" where it would otherwise say "renews". Without that
   * distinction the billing page told someone who had just cancelled that their
   * plan renews on the date it will in fact end.
   */
  cancelsAt: Date | null = null,
): { plan: PlanId; status: string } {
  switch (status) {
    case "active":
    case "trialing":
      return { plan: plan ?? "free", status: cancelsAt ? "canceling" : status };
    case "past_due":
      // Keep the plan, mark it so the UI can warn.
      return { plan: plan ?? "free", status: "past_due" };
    case "canceled":
    case "unpaid":
    case "incomplete":
    case "incomplete_expired":
    case "paused":
      return { plan: "free", status };
    default:
      // An unrecognised status is treated as not entitled. New statuses should
      // fail closed, because the alternative is granting a paid plan on a state
      // this code has never seen.
      return { plan: "free", status: String(status) };
  }
}

/** The price id on a subscription, if it has exactly one recognisable item. */
export function priceIdOf(subscription: Stripe.Subscription): string | null {
  const items = subscription.items?.data ?? [];
  const first = items[0];
  return first?.price?.id ?? null;
}

/**
 * The instant a scheduled cancellation takes effect, or null if none is scheduled.
 *
 * ## Why this reads two fields rather than one
 *
 * Stripe has two representations of "cancelled, but still paid up", and which one
 * a subscription carries depends on how it was cancelled and on the API version:
 *
 *   - the **legacy** form sets `cancel_at_period_end: true` and leaves `cancel_at`
 *     null, meaning "end this when the current period does";
 *   - the **current** form sets `cancel_at` to a concrete timestamp and leaves
 *     `cancel_at_period_end` **false**, with `canceled_at` recording when the
 *     request was made.
 *
 * Reading only the boolean therefore misses a real cancellation entirely. That is
 * not hypothetical: a sandbox cancellation through the Customer Portal produced
 * `status: active`, `cancel_at_period_end: false`, `cancel_at` one month out, and
 * `canceled_at` four minutes earlier — and the first version of this code, which
 * checked only the boolean, concluded nothing had been cancelled.
 *
 * `canceled_at` is deliberately **not** the signal. It records when a cancellation
 * was *requested*, and a subscription that was scheduled and then resumed can
 * carry a stale one; the question here is whether an end is still coming.
 *
 * A `cancel_at` in the past is also ignored: Stripe would have moved the status to
 * `canceled`, so a past timestamp on an active subscription is not an end that is
 * still pending, and treating it as one would revoke a plan that is live.
 */
export function scheduledCancellationAt(subscription: Stripe.Subscription): Date | null {
  const cancelAt = (subscription as unknown as { cancel_at?: number | null }).cancel_at;
  if (typeof cancelAt === "number" && cancelAt * 1000 > Date.now()) {
    return new Date(cancelAt * 1000);
  }
  // Legacy representation: no explicit instant, so the end is the period end.
  if (subscription.cancel_at_period_end) return periodEndOf(subscription);
  return null;
}

/**
 * When the current paid period ends, as a Date.
 *
 * Read from the subscription item rather than the subscription: Stripe moved
 * `current_period_end` onto items, and reading the old location silently yields
 * undefined, which would render as "no renewal date" on a healthy subscription.
 */
export function periodEndOf(subscription: Stripe.Subscription): Date | null {
  const item = subscription.items?.data?.[0] as { current_period_end?: number } | undefined;
  const seconds =
    item?.current_period_end ??
    (subscription as unknown as { current_period_end?: number }).current_period_end;
  return typeof seconds === "number" ? new Date(seconds * 1000) : null;
}
