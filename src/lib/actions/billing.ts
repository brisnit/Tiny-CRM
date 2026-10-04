"use server";

import { z } from "zod";

import { action, guard, type ActionResult } from "@/lib/actions/base";
import { createCheckoutSession, createPortalSession } from "@/lib/billing/stripe";
import { AppError } from "@/lib/errors";
import { appOrigin } from "@/lib/origin";
import { stripeConfigured } from "@/lib/env";
import { PLANS, type PlanId } from "@/lib/plans";

/**
 * Starting a subscription and managing one.
 *
 * ## The authorisation argument
 *
 * Neither function takes an account, a workspace or a customer id. The only
 * account either can act on is `actor.identity.id`, which comes from the session
 * inside `action()`. There is therefore no parameter through which one customer
 * could name another's billing — the check is not a condition that could be got
 * wrong, it is the absence of anything to check.
 *
 * This is also why these are server actions rather than route handlers. A route
 * reachable by GET is reachable by a link, and a link is something a third-party
 * page can make a browser follow; Next's server actions are POST-only with an
 * origin-bound action id.
 *
 * ## What they do not do
 *
 * Neither grants anything. Checkout returns a Stripe URL and the portal returns a
 * Stripe URL; the plan moves only when the verified webhook says Stripe charged
 * someone. The success page is a navigation and navigations can be typed.
 */

const planSchema = z.enum(["plus", "pro"] as [PlanId, ...PlanId[]]);

/**
 * Creates a Checkout session for the signed-in account and returns its URL.
 *
 * The caller redirects the browser. Returning the URL rather than redirecting
 * server-side keeps the failure visible: a misconfigured price shows an error in
 * the UI instead of a bounce to Stripe that dead-ends.
 */
export async function startCheckout(plan: string): Promise<ActionResult<{ url: string }>> {
  return guard(() =>
    action(
      async (actor) => {
        if (!stripeConfigured()) {
          throw new AppError("internal", "Checkout is not available on this deployment yet.");
        }

        const planId = planSchema.parse(plan);
        const target = PLANS[planId];

        if (!target.purchasable) {
          throw new AppError("validation", "That plan is not available.");
        }
        if (actor.identity.plan === planId) {
          throw new AppError("validation", `You are already on ${target.name}.`);
        }

        // A legacy plan holder going through Checkout would end up with a Stripe
        // subscription on top of entitlements they already hold permanently, and
        // the webhook would then *reduce* them to the new tier. Refused here with
        // an explanation rather than silently downgrading someone who paid.
        if (!PLANS[(actor.identity.plan ?? "free") as PlanId]?.purchasable) {
          throw new AppError(
            "validation",
            "Your current plan was set up before online billing. Get in touch before changing it " +
              "so your existing access is not reduced.",
          );
        }

        const origin = appOrigin();
        const url = await createCheckoutSession({
          userId: actor.identity.id,
          plan: planId,
          // `checkout=complete` is a *hint for copy only*. The page it lands on
          // reads the stored plan, which only the webhook can change, so a user
          // who types this URL sees their real plan and not an upgrade.
          successUrl: `${origin}/settings/billing?checkout=complete`,
          cancelUrl: `${origin}/settings/billing?checkout=cancelled`,
        });

        return { url };
      },
      { rateLimit: "billing" },
    ),
  );
}

/**
 * Opens the Stripe Customer Portal for the signed-in account.
 *
 * Payment methods, invoices, plan changes and cancellation all live there. The
 * alternative — rebuilding them here — means a second implementation of
 * proration and dunning that has to agree with Stripe's, and the cost of
 * disagreement is a customer charged the wrong amount.
 */
export async function openBillingPortal(): Promise<ActionResult<{ url: string }>> {
  return guard(() =>
    action(
      async (actor) => {
        if (!stripeConfigured()) {
          throw new AppError("internal", "Billing management is not available on this deployment yet.");
        }

        const url = await createPortalSession({
          userId: actor.identity.id,
          returnUrl: `${appOrigin()}/settings/billing`,
        });

        return { url };
      },
      { rateLimit: "billing" },
    ),
  );
}
