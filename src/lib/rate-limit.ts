import "server-only";

import { env } from "@/lib/env";
import { rateLimited } from "@/lib/errors";
import { log } from "@/lib/logger";

/**
 * Rate limiting.
 *
 * A fixed-window counter behind a small interface. The default store is
 * in-process, which is correct for a single instance and honest about its
 * limitation: counters reset on deploy and are not shared between instances.
 * `RATE_LIMIT_REDIS_URL` is the seam for a shared store — implementing
 * `RateLimitStore` against Upstash or Redis is the whole change.
 */

export type RateLimitStore = {
  /** Increments the counter for `key` and returns the new count and window end. */
  hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
  reset(key: string): Promise<void>;
};

class MemoryStore implements RateLimitStore {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = Date.now();

  async hit(key: string, windowMs: number) {
    const now = Date.now();
    this.sweep(now);

    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      const bucket = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
      return bucket;
    }
    existing.count += 1;
    return existing;
  }

  async reset(key: string) {
    this.buckets.delete(key);
  }

  /** Bounded memory: expired buckets are dropped, at most once a minute. */
  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

const globalForLimiter = globalThis as unknown as { rateLimitStore?: RateLimitStore };
const store: RateLimitStore = (globalForLimiter.rateLimitStore ??= new MemoryStore());

export type Policy = { limit: number; windowMs: number; label: string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Per-operation policies. Authentication is deliberately the tightest: it is the
 * only endpoint where a successful guess grants everything.
 */
export const POLICIES = {
  login: { limit: 10, windowMs: 15 * MINUTE, label: "sign-in attempts" },
  loginPerAccount: { limit: 5, windowMs: 15 * MINUTE, label: "sign-in attempts for this account" },
  signup: { limit: 5, windowMs: HOUR, label: "sign-ups" },
  passwordReset: { limit: 5, windowMs: HOUR, label: "password reset requests" },
  ai: { limit: 20, windowMs: MINUTE, label: "Tiny AI requests" },
  aiHourly: { limit: 200, windowMs: HOUR, label: "Tiny AI requests" },
  search: { limit: 60, windowMs: MINUTE, label: "searches" },
  options: { limit: 120, windowMs: MINUTE, label: "lookups" },
  mutation: { limit: 240, windowMs: MINUTE, label: "changes" },
  import: { limit: 5, windowMs: 10 * MINUTE, label: "imports" },
  export: { limit: 10, windowMs: HOUR, label: "exports" },
  upload: { limit: 30, windowMs: HOUR, label: "uploads" },
  bulk: { limit: 10, windowMs: MINUTE, label: "bulk actions" },
  webhook: { limit: 600, windowMs: MINUTE, label: "webhook deliveries" },
} as const satisfies Record<string, Policy>;

export type PolicyName = keyof typeof POLICIES;

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
  limit: number;
};

/** Checks a policy without throwing. */
export async function checkRateLimit(
  policyName: PolicyName,
  identifier: string,
): Promise<RateLimitResult> {
  const policy = POLICIES[policyName];
  const key = `${policyName}:${identifier}`;
  const { count, resetAt } = await store.hit(key, policy.windowMs);
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));

  return {
    ok: count <= policy.limit,
    remaining: Math.max(0, policy.limit - count),
    retryAfterSeconds,
    limit: policy.limit,
  };
}

/** Checks a policy and throws a rate-limit error when exceeded. */
export async function enforceRateLimit(
  policyName: PolicyName,
  identifier: string,
): Promise<void> {
  const result = await checkRateLimit(policyName, identifier);
  if (result.ok) return;

  const policy = POLICIES[policyName];
  log.warn("rate limit exceeded", { policy: policyName, identifier: hashIdentifier(identifier) });
  throw rateLimited(
    `Too many ${policy.label}. Try again in ${formatWait(result.retryAfterSeconds)}.`,
    result.retryAfterSeconds,
  );
}

export async function resetRateLimit(policyName: PolicyName, identifier: string) {
  await store.reset(`${policyName}:${identifier}`);
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

/** Identifiers are hashed before logging so logs never carry raw addresses. */
function hashIdentifier(identifier: string): string {
  let hash = 0;
  for (let i = 0; i < identifier.length; i++) hash = (hash * 31 + identifier.charCodeAt(i)) | 0;
  return `id_${Math.abs(hash).toString(36)}`;
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function rateLimitBackend(): "memory" | "redis" {
  return env.rateLimitRedisUrl ? "redis" : "memory";
}
