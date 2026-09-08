import { env, isProduction } from "@/lib/env";
import { log } from "@/lib/logger";

/**
 * The one place that decides what origin a customer-facing link uses.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 *
 * Password-reset and email-verification links were being built straight from
 * `env.appUrl`, which resolves `APP_URL ?? NEXT_PUBLIC_SITE_URL ??
 * "http://localhost:3000"`. Nothing validated the *shape* of that value beyond
 * "is HTTPS" and "is not localhost", so a deployment hostname passed every
 * check and went out in real account-recovery email.
 *
 * That is an account-lifecycle failure, not a cosmetic one. A reset link on a
 * deployment URL still works today and stops working the moment that
 * deployment is superseded — so the person locked out of their account clicks
 * a link that 404s, with no way to tell whether the problem is them, the link,
 * or the product. It also trains customers to trust a domain that is not ours.
 *
 * ---------------------------------------------------------------------------
 * The rule
 * ---------------------------------------------------------------------------
 *
 * In production the origin must be a canonical public HTTPS origin. A
 * deployment hostname is explicitly not one, and neither is localhost or a bare
 * IP. If the configured value fails that test, this returns the canonical
 * origin anyway and says so at error level, because a working link on the right
 * domain is better than a broken one on the wrong domain — and better than
 * refusing to send a reset to someone already locked out.
 *
 * `VERCEL_URL` is never consulted. It holds the immutable per-deployment
 * hostname, which is precisely the value that must not reach a customer.
 */

/** The domain Tiny CRM is served on. Changing this is a deliberate act. */
export const CANONICAL_PRODUCTION_ORIGIN = "https://tinycrm.biz";

const DEVELOPMENT_ORIGIN = "http://localhost:3000";

type Verdict = { ok: true; origin: string } | { ok: false; reason: string };

/**
 * Is this a public origin we would put in an email?
 *
 * Shape only — it deliberately does not require equality with the canonical
 * constant, so a second legitimate domain can be configured later without a
 * code change.
 */
export function validatePublicOrigin(candidate: string | undefined): Verdict {
  if (!candidate) return { ok: false, reason: "not set" };

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "is not a valid URL" };
  }

  if (url.protocol !== "https:") return { ok: false, reason: `is not HTTPS (${url.protocol})` };

  const host = url.hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(host)) {
    return { ok: false, reason: "points at localhost" };
  }
  // A deployment hostname changes every deploy; a link built from one dies with
  // the deployment that produced it.
  if (host.endsWith(".vercel.app") || host === "vercel.app") {
    return { ok: false, reason: "is a deployment hostname, not a canonical domain" };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return { ok: false, reason: "is a bare IP address" };
  if (!host.includes(".")) return { ok: false, reason: "has no public domain" };

  // Normalised so `${origin}/reset-password` can never produce a double slash.
  return { ok: true, origin: `${url.protocol}//${url.host}` };
}

let warned = false;

/**
 * The origin for every customer-facing absolute link.
 *
 * Use this rather than `env.appUrl` anywhere a URL will reach a person.
 */
export function appOrigin(): string {
  const verdict = validatePublicOrigin(env.appUrl);

  if (!isProduction) {
    // Preview and development keep whatever they are configured with, so a
    // preview deployment can still link to itself.
    return verdict.ok ? verdict.origin : (env.appUrl || DEVELOPMENT_ORIGIN).replace(/\/+$/, "");
  }

  if (verdict.ok) return verdict.origin;

  // Loud, once per process, and with the offending value — this is a
  // configuration error somebody has to fix, and hiding it would leave the
  // fallback silently papering over it forever.
  if (!warned) {
    warned = true;
    log.error("APP_URL is not a canonical public origin; falling back", {
      configured: env.appUrl,
      reason: verdict.reason,
      using: CANONICAL_PRODUCTION_ORIGIN,
    });
  }
  return CANONICAL_PRODUCTION_ORIGIN;
}
