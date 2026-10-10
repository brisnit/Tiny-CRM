import { stripeMode } from "@/lib/env";

/**
 * Links into the Stripe Dashboard for a customer.
 *
 * Test-mode and live-mode objects live at different paths, and sending an
 * operator to the wrong one shows an empty page rather than an error — so the
 * mode comes from the same function the rest of billing uses rather than being
 * assumed.
 *
 * Only ever a link. Charges, refunds, cancellation and plan switching are
 * Stripe's to do, and rebuilding any of them here would mean reimplementing
 * the parts of billing most expensive to get wrong.
 */
export function stripeDashboardUrls(customerId: string | null): { customer: string } | null {
  if (!customerId) return null;
  const prefix = stripeMode() === "live" ? "" : "/test";
  return { customer: `https://dashboard.stripe.com${prefix}/customers/${customerId}` };
}
