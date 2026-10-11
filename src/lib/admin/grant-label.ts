/**
 * How a complimentary grant is described on the admin pages.
 *
 * A pure function rather than a string inside the badge, so the wording is
 * covered by a test. The wording is the point: it is the only thing standing
 * between an operator and a wrong conclusion about an account they are about
 * to change.
 *
 * Deliberately not "server-only" — the label belongs to whichever surface
 * shows it.
 */

export type GrantLabelInput = {
  plan: string;
  expiresAt: Date | null;
  /** Whether the grant is currently raising the effective plan. */
  inForce: boolean;
};

/**
 * The reason this does not say "inactive".
 *
 * A grant that adds nothing today is **not** inactive: it is live, it is
 * stored, it will still expire on its date, and — crucially — it will start
 * adding access again the moment the account's own plan drops below it, for
 * instance when a subscription lapses. Calling it inactive invites an operator
 * to issue a second grant for a grant that already exists, or to read the
 * expiry as already past.
 *
 * What is inactive is the *effect*, so that is what the words say.
 */
export const NO_EFFECT_LABEL = "No additional access currently";

export function complimentaryBadgeLabel(grant: GrantLabelInput): string {
  const expiry = grant.expiresAt
    ? ` · to ${grant.expiresAt.toISOString().slice(0, 10)}`
    : " · no expiry";
  return (
    `Complimentary: ${titleiseGrantPlan(grant.plan)}${expiry}` +
    (grant.inForce ? "" : ` · ${NO_EFFECT_LABEL}`)
  );
}

export function complimentaryBadgeTitle(grant: GrantLabelInput, reason: string): string {
  return (
    `Complimentary ${titleiseGrantPlan(grant.plan)} — ${reason}. ` +
    `No Stripe subscription, no charge.` +
    (grant.expiresAt ? ` Expires ${grant.expiresAt.toISOString().slice(0, 10)}.` : " No expiry.") +
    (grant.inForce
      ? ""
      : ` ${NO_EFFECT_LABEL}: the account's own plan already matches or exceeds it. ` +
        `The grant is still live and still expires on the date shown.`)
  );
}

function titleiseGrantPlan(plan: string): string {
  return plan
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
