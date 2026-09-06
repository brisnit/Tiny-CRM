import "server-only";

import { rateLimited } from "@/lib/errors";
import { log } from "@/lib/logger";
import {
  selectStore, storeKey,
  type BackendChoice, type RateLimitStore,
} from "@/lib/rate-limit/stores";

/**
 * Rate limiting.
 *
 * A fixed-window counter behind a narrow interface, with three backends
 * (`src/lib/rate-limit/stores.ts`). The default in development is in-process;
 * production uses Redis or the application's own PostgreSQL, and refuses to
 * start on the in-process store when it is told to expect more than one
 * instance — see `assertProductionEnv()`.
 *
 * ---------------------------------------------------------------------------
 * Dimensions
 * ---------------------------------------------------------------------------
 *
 * Most limits apply on more than one axis at once, because each axis alone has
 * a known bypass:
 *
 *   ip         stops one host trying many accounts (password spraying),
 *              but not a botnet.
 *   account    stops many hosts trying one account (credential stuffing),
 *              but not a spray across many accounts.
 *   user       stops an authenticated account from being expensive,
 *              but not an organisation from being expensive across seats.
 *   workspace  stops one tenant's seats from collectively exhausting a shared
 *              resource, which per-user limits never notice.
 *
 * `enforceRateLimit` takes whichever of these the caller can supply and applies
 * every configured one. **All** must pass; the first refusal wins, and its
 * retry-after is the one reported.
 *
 * Identifiers are hashed with a keyed digest before they are stored, so the
 * backend never accumulates a list of email addresses and IP addresses.
 */

export type { RateLimitStore } from "@/lib/rate-limit/stores";

const globalForLimiter = globalThis as unknown as { rateLimitBackend?: BackendChoice };
const backend: BackendChoice = (globalForLimiter.rateLimitBackend ??= selectStore());
const store: RateLimitStore = backend.store;

export type Dimension = "ip" | "account" | "user" | "workspace" | "global";

export type Policy = {
  limit: number;
  windowMs: number;
  label: string;
  /**
   * Which axes this policy is counted on, and the limit for each. The bare
   * `limit` above applies to the primary axis; an entry here overrides it.
   */
  per?: Partial<Record<Dimension, number>>;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Per-operation policies. Authentication is deliberately the tightest: it is the
 * only endpoint where a successful guess grants everything.
 */
export const POLICIES = {
  // --- Authentication -------------------------------------------------------
  login: {
    limit: 10, windowMs: 15 * MINUTE, label: "sign-in attempts",
    per: { ip: 10, account: 5 },
  },
  loginPerAccount: { limit: 5, windowMs: 15 * MINUTE, label: "sign-in attempts for this account" },
  signup: { limit: 5, windowMs: HOUR, label: "sign-ups", per: { ip: 5 } },
  passwordReset: {
    limit: 5, windowMs: HOUR, label: "password reset requests",
    // Tighter per account than per address: a reset flood aimed at one inbox is
    // harassment as much as it is an attack.
    per: { ip: 10, account: 3 },
  },
  emailVerification: {
    limit: 5, windowMs: HOUR, label: "verification emails",
    per: { ip: 10, account: 3 },
  },
  mfaChallenge: {
    limit: 10, windowMs: 15 * MINUTE, label: "two-factor attempts",
    // A six-digit TOTP code has a million possibilities; a tight per-account
    // limit is what keeps that space out of reach.
    per: { ip: 20, account: 10 },
  },

  // --- Expensive reads ------------------------------------------------------
  ai: { limit: 20, windowMs: MINUTE, label: "Tiny AI requests", per: { user: 20, workspace: 60 } },
  aiHourly: { limit: 200, windowMs: HOUR, label: "Tiny AI requests", per: { user: 200, workspace: 600 } },
  search: { limit: 60, windowMs: MINUTE, label: "searches", per: { user: 60, workspace: 300 } },
  options: { limit: 120, windowMs: MINUTE, label: "lookups" },
  analytics: { limit: 30, windowMs: MINUTE, label: "analytics requests", per: { user: 30, workspace: 120 } },

  // --- Writes and bulk operations ------------------------------------------
  mutation: { limit: 240, windowMs: MINUTE, label: "changes" },
  bulk: { limit: 10, windowMs: MINUTE, label: "bulk actions", per: { user: 10, workspace: 30 } },
  import: { limit: 5, windowMs: 10 * MINUTE, label: "imports", per: { user: 5, workspace: 10 } },
  export: {
    limit: 10, windowMs: HOUR, label: "exports",
    // Also capped per workspace: an export is the shape a data exfiltration
    // takes, and one seat per person is not a meaningful ceiling on a team.
    per: { user: 10, workspace: 25 },
  },
  upload: { limit: 30, windowMs: HOUR, label: "uploads", per: { user: 30, workspace: 100 } },

  // --- Unauthenticated surfaces --------------------------------------------
  webhook: { limit: 600, windowMs: MINUTE, label: "webhook deliveries", per: { ip: 600 } },
} as const satisfies Record<string, Policy>;

export type PolicyName = keyof typeof POLICIES;

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
  limit: number;
  /** Which axis refused, when one did. */
  dimension?: Dimension;
};

export type Identity = Partial<Record<Dimension, string | null | undefined>>;

/**
 * Normalises the caller's argument.
 *
 * Accepts a bare string for the many call sites that only have one identifier,
 * so adopting the multi-dimensional form is incremental rather than a flag day.
 */
function toIdentity(identity: string | Identity): Identity {
  return typeof identity === "string" ? { global: identity } : identity;
}

/** Checks a policy on every axis it declares, without throwing. */
export async function checkRateLimit(
  policyName: PolicyName,
  identity: string | Identity,
): Promise<RateLimitResult> {
  const policy: Policy = POLICIES[policyName];
  const supplied = toIdentity(identity);

  // Which axes actually apply: those the policy declares *and* the caller could
  // supply. A policy asking for a workspace limit on an unauthenticated
  // endpoint simply does not get one, rather than failing.
  const axes: [Dimension, number][] = [];
  if (policy.per) {
    for (const [dimension, limit] of Object.entries(policy.per) as [Dimension, number][]) {
      if (supplied[dimension]) axes.push([dimension, limit]);
    }
  }
  if (axes.length === 0) {
    const fallback = supplied.global ?? supplied.user ?? supplied.ip ?? supplied.account;
    if (!fallback) {
      // Nothing to count against. Refusing would break a legitimate call; the
      // absence is logged so it can be found rather than silently ignored.
      log.warn("rate limit skipped: no identifier", { policy: policyName });
      return { ok: true, remaining: policy.limit, retryAfterSeconds: 0, limit: policy.limit };
    }
    return single(policyName, "global", fallback, policy.limit, policy.windowMs);
  }

  const results = await Promise.all(
    axes.map(([dimension, limit]) =>
      single(policyName, dimension, supplied[dimension]!, limit, policy.windowMs),
    ),
  );

  // The first refusal wins, and reports its own retry-after.
  const refused = results.find((r) => !r.ok);
  if (refused) return refused;

  return results.reduce((tightest, r) => (r.remaining < tightest.remaining ? r : tightest));
}

async function single(
  policyName: string,
  dimension: Dimension,
  identifier: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const key = storeKey(`${policyName}:${dimension}`, identifier);

  let hit: { count: number; resetAt: number };
  try {
    hit = await store.hit(key, windowMs);
  } catch (error) {
    // A shared store can be briefly unreachable. Failing *open* here is a
    // deliberate availability choice: a Redis blip must not lock every customer
    // out of the product. It is logged at error level so an outage is visible,
    // and the account lockout in src/auth.ts is an independent control that does
    // not depend on this store at all.
    log.error("rate limit store unavailable; allowing request", {
      policy: policyName, dimension, backend: backend.kind, error: String(error),
    });
    return { ok: true, remaining: limit, retryAfterSeconds: 0, limit, dimension };
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((hit.resetAt - Date.now()) / 1000));
  return {
    ok: hit.count <= limit,
    remaining: Math.max(0, limit - hit.count),
    retryAfterSeconds,
    limit,
    dimension,
  };
}

/** Checks a policy and throws a rate-limit error when exceeded. */
export async function enforceRateLimit(
  policyName: PolicyName,
  identity: string | Identity,
): Promise<void> {
  const result = await checkRateLimit(policyName, identity);
  if (result.ok) return;

  const policy = POLICIES[policyName];
  log.warn("rate limit exceeded", {
    policy: policyName,
    dimension: result.dimension,
    backend: backend.kind,
  });

  throw rateLimited(
    `Too many ${policy.label}. Try again in ${formatWait(result.retryAfterSeconds)}.`,
    result.retryAfterSeconds,
  );
}

/** Clears every axis of a policy for one identity. Used by tests and by sign-in success. */
export async function resetRateLimit(
  policyName: PolicyName,
  identity: string | Identity,
): Promise<void> {
  const supplied = toIdentity(identity);
  const dimensions: Dimension[] = ["ip", "account", "user", "workspace", "global"];

  await Promise.all(
    dimensions
      .filter((d) => supplied[d])
      .map((d) => store.reset(storeKey(`${policyName}:${d}`, supplied[d]!))),
  );

  // A bare string is stored on the `global` axis; clearing it covers the common
  // single-identifier call.
  if (typeof identity === "string") {
    await store.reset(storeKey(`${policyName}:global`, identity));
  }
}

/**
 * Client address from proxy headers. Only the left-most entry of
 * `x-forwarded-for` is meaningful, and it is spoofable unless the platform
 * rewrites it — which Vercel and most managed hosts do. Documented in
 * docs/SECURITY.md as an assumption.
 */
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return headers.get("x-real-ip") ?? "unknown";
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** What backend is in use, and whether it is actually shared between instances. */
export function rateLimitBackend(): { kind: BackendChoice["kind"]; distributed: boolean; reason: string } {
  return { kind: backend.kind, distributed: backend.distributed, reason: backend.reason };
}

export async function rateLimitHealthy(): Promise<boolean> {
  return store.healthy();
}
