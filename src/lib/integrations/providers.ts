import "server-only";

import { env } from "@/lib/env";

/**
 * The four connectors, as data rather than as four code paths.
 *
 * Every provider-specific fact lives here — endpoints, scopes, whether PKCE is
 * supported, what the account's own address is called in the userinfo response.
 * The OAuth and sync code takes a `ProviderConfig` and does not branch on the
 * provider id, so adding a fifth connector is a table entry and a sync adapter
 * rather than a fifth copy of the handshake.
 *
 * ## Scopes are read-only, and deliberately the narrowest that work
 *
 * Phase 1 imports. It does not send mail, create events or modify anything at
 * the provider, so no scope here grants a write. That is not only a privacy
 * position: Google classifies by scope, and asking for one more than needed is
 * what turns a sensitive app into a restricted one.
 *
 * ## Availability is a fact about approval, not about our code
 *
 * `availability` records whether a provider can be offered to customers at all
 * yet. Gmail is `blocked`: Google classifies **both** `gmail.readonly` and
 * `gmail.metadata` as restricted, so there is no narrower read scope, and
 * restricted scopes need verification plus an annual independent security
 * assessment before the public may grant them. The connector is built and
 * tested; it stays unreachable until that clears. See docs/INTEGRATIONS.md.
 */

export type ProviderId = "gmail" | "outlook" | "google_calendar" | "outlook_calendar";

export type ProviderKind = "email" | "calendar";

export type ProviderConfig = {
  id: ProviderId;
  /** What a customer sees. */
  label: string;
  kind: ProviderKind;
  /** Which vendor's OAuth server, since two providers share each. */
  vendor: "google" | "microsoft";
  authorizeUrl: string;
  tokenUrl: string;
  /** Where to revoke a grant, when the vendor offers it. */
  revokeUrl: string | null;
  scopes: readonly string[];
  /**
   * Whether the vendor supports PKCE for a confidential client.
   *
   * Both do, and both are used with it. Recorded rather than assumed so that a
   * provider which does not cannot be added silently — the authorisation
   * builder refuses to omit a challenge unless this says so.
   */
  pkce: boolean;
  /**
   * `offered` — a customer may connect it once the flag and plan allow.
   * `blocked` — approval is outstanding; never offer it, whatever the flag says.
   */
  availability: "offered" | "blocked";
  /** Shown where the reason matters, which is anywhere it is refused. */
  blockedReason?: string;
};

/**
 * Microsoft's authority is **tenant-specific**, not `/common`.
 *
 * The first version of this file used `/common` on the reasoning that a
 * customer in any tenant should be able to connect. That is wrong for the
 * registration we actually have, and wrong in a way worth recording:
 *
 *   - The canary app is registered **single tenant**. `/common` is refused for
 *     anyone outside the registration's tenant (AADSTS50194), so it buys no
 *     reach at all until the registration becomes multi-tenant.
 *   - More importantly, `/common` never states which tenant we expect, so
 *     there is nothing to check the returned token against. A tenant-specific
 *     authority plus a `tid` check means a token minted by some other tenant is
 *     rejected rather than trusted because the handshake completed.
 *
 * Federation is a red herring here. The canary's domain is federated to a
 * third-party identity provider, so sign-in detours through it — but that is
 * Microsoft's business, happens inside the tenant-specific authority, and is
 * not a reason to widen the authority.
 *
 * When the app becomes multi-tenant for public availability, this becomes
 * `/organizations` with the `tid` recorded per connection rather than compared
 * against one expected value. That is a deliberate later change, not a default.
 */
function microsoftAuthority(): string {
  const tenant = env.microsoftTenantId;
  if (!tenant) {
    // Not an assertion failure: with no tenant configured the Microsoft
    // connectors are unconfigured, and `isConfigured` below is what callers
    // check. The placeholder makes a misuse obvious rather than silently
    // producing a `/common` URL.
    return "https://login.microsoftonline.com/MICROSOFT_TENANT_ID-is-not-set";
  }
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}`;
}

const MS_AUTHORIZE = `${microsoftAuthority()}/oauth2/v2.0/authorize`;
const MS_TOKEN = `${microsoftAuthority()}/oauth2/v2.0/token`;

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  outlook: {
    id: "outlook",
    label: "Outlook email",
    kind: "email",
    vendor: "microsoft",
    authorizeUrl: MS_AUTHORIZE,
    tokenUrl: MS_TOKEN,
    // Microsoft has no OAuth revocation endpoint for delegated grants; a
    // customer removes access from their account page, and we delete our copy.
    revokeUrl: null,
    scopes: [
      // `openid` is what makes the token response include an id_token, which is
      // where the `tid` claim lives — without it there is nothing to validate
      // the tenant against. `openid`, `profile`, `email` and `offline_access`
      // are OIDC scopes rather than Graph permissions: they need no entry in
      // the app registration's API permissions and no admin consent.
      "openid", "profile", "email", "offline_access",
      "https://graph.microsoft.com/User.Read",
      "https://graph.microsoft.com/Mail.Read",
    ],
    pkce: true,
    availability: "offered",
  },
  outlook_calendar: {
    id: "outlook_calendar",
    label: "Outlook Calendar",
    kind: "calendar",
    vendor: "microsoft",
    authorizeUrl: MS_AUTHORIZE,
    tokenUrl: MS_TOKEN,
    revokeUrl: null,
    scopes: [
      "openid", "profile", "email", "offline_access",
      "https://graph.microsoft.com/User.Read",
      "https://graph.microsoft.com/Calendars.Read",
    ],
    pkce: true,
    availability: "offered",
  },
  google_calendar: {
    id: "google_calendar",
    label: "Google Calendar",
    kind: "calendar",
    vendor: "google",
    authorizeUrl: GOOGLE_AUTHORIZE,
    tokenUrl: GOOGLE_TOKEN,
    revokeUrl: GOOGLE_REVOKE,
    scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
    pkce: true,
    availability: "offered",
  },
  gmail: {
    id: "gmail",
    label: "Gmail",
    kind: "email",
    vendor: "google",
    authorizeUrl: GOOGLE_AUTHORIZE,
    tokenUrl: GOOGLE_TOKEN,
    revokeUrl: GOOGLE_REVOKE,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    pkce: true,
    availability: "blocked",
    blockedReason:
      "Gmail read access is a restricted Google scope. It needs app verification " +
      "and an annual independent security assessment before anyone outside our " +
      "own organisation can grant it.",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/** Narrows an untrusted string — a route parameter — to a known provider. */
export function providerFor(id: string): ProviderConfig | null {
  return Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id as ProviderId] : null;
}

/**
 * Whether this provider may be offered at all.
 *
 * Separate from the feature flag and the plan, and checked in addition to
 * them: a flag is our rollout, a plan is the customer's entitlement, and this
 * is the provider's permission. Switching the flag on must not make Gmail
 * connectable.
 */
export function isOfferable(provider: ProviderConfig): boolean {
  return provider.availability === "offered";
}

/**
 * Whether this deployment has credentials for the provider's vendor.
 *
 * Distinct from `isOfferable`, which is about the vendor's approval, and from
 * the feature flag, which is about our rollout. A provider can be approved,
 * flagged on and entitled, and still have no client secret in this
 * environment — which is exactly the state of every environment right now.
 */
export function isConfigured(provider: ProviderConfig): boolean {
  if (provider.vendor === "microsoft") {
    return Boolean(env.microsoftClientId && env.microsoftTenantId && env.microsoftClientSecret);
  }
  return Boolean(env.googleClientId && env.googleClientSecret);
}

/** The tenant a Microsoft token must have been minted by, or null. */
export function expectedMicrosoftTenant(): string | null {
  return env.microsoftTenantId ?? null;
}
