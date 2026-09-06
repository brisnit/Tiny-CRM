import "server-only";

import { AppError } from "@/lib/errors";
import type { Identity } from "@/lib/auth/context";

/**
 * What an unverified account may do.
 *
 * Centralised here rather than checked at each call site, so the policy is one
 * table that can be read in full and changed in one place — the same reason the
 * permission grants live in one table.
 *
 * The shape of the decision: an unverified user may **explore and build their
 * own workspace**, because making someone check their email before they can see
 * anything is how a product loses the people it just persuaded. What they may
 * not do is anything that reaches other people or leaves the system:
 *
 *   - invite anyone, or change anyone's role — an unverified address may not be
 *     theirs, and an invitation is a permanent grant to an inbox;
 *   - export or import in bulk — the account-takeover payoff, and the shape an
 *     exfiltration takes;
 *   - connect an integration — which grants Tiny CRM access to a mailbox or
 *     calendar under credentials that would outlive the account;
 *   - change billing.
 *
 * The check is not "is this dangerous" but "does this reach past the person
 * sitting in front of it".
 */

export const VERIFICATION_GATED = [
  "members:manage",
  "record:export",
  "import:run",
  "integrations:manage",
  "billing:manage",
  "workspace:delete",
] as const;

export type GatedCapability = (typeof VERIFICATION_GATED)[number];

const GATED = new Set<string>(VERIFICATION_GATED);

/**
 * Whether verification is being enforced at all.
 *
 * When no mail provider is configured, nobody can verify — so enforcing the gate
 * would lock every account out of exports and invitations with no way forward.
 * The gate therefore follows the ability to deliver mail, and the startup
 * warnings already say when that is missing.
 *
 * This is a deliberate weakening and it is stated rather than hidden: a
 * deployment with no mail provider has no email verification, and the readiness
 * scorecard reports it that way.
 */
export function verificationEnforced(mailConfigured: boolean): boolean {
  return mailConfigured;
}

export function isVerified(identity: Pick<Identity, "emailVerifiedAt">): boolean {
  return Boolean(identity.emailVerifiedAt);
}

export function requiresVerification(capability: string): boolean {
  return GATED.has(capability);
}

/**
 * Throws when an unverified account attempts a gated capability.
 *
 * Called from `requireWorkspaceAccess` after the permission check, so a user
 * sees "your role cannot do this" when that is the reason and "confirm your
 * email" only when the role would otherwise allow it. The order matters: the
 * other way around tells an under-privileged user that verifying would help,
 * which is not true.
 */
export function assertVerified(
  identity: Pick<Identity, "emailVerifiedAt">,
  capability: string,
  options: { enforced: boolean },
): void {
  if (!options.enforced) return;
  if (!requiresVerification(capability)) return;
  if (isVerified(identity)) return;

  throw new AppError(
    "forbidden",
    "Confirm your email address first. Check your inbox, or send a new link from Settings → Security.",
    { meta: { reason: "email_unverified", capability } },
  );
}
