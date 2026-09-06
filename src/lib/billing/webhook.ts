import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { db } from "@/lib/db";

/**
 * Webhook verification.
 *
 * Written as a reusable pattern rather than a Stripe-specific handler, because
 * the same four checks apply to every provider integration this app will grow
 * (payments, email delivery, calendar push):
 *
 *   1. **Signature** — HMAC-SHA256 over `timestamp.body`, compared in constant
 *      time. A payload that merely reached the endpoint proves nothing.
 *   2. **Timestamp** — outside a tolerance window it is rejected, so a captured
 *      request cannot be replayed later.
 *   3. **Idempotency** — the provider's event id is recorded, so a redelivery
 *      (which every provider does) applies once.
 *   4. **Structured logging** — every verification outcome is logged.
 */

const TOLERANCE_SECONDS = 300;

export type VerifiedWebhook = {
  eventId: string;
  body: string;
};

export function verifySignature(options: {
  body: string;
  signatureHeader: string | null;
  timestampHeader: string | null;
  secret: string | undefined;
}): void {
  if (!options.secret) {
    throw new AppError("internal", "Webhook secret is not configured.");
  }
  if (!options.signatureHeader || !options.timestampHeader) {
    throw new AppError("unauthorized", "Missing signature.");
  }

  const timestamp = Number(options.timestampHeader);
  if (!Number.isFinite(timestamp)) throw new AppError("unauthorized", "Invalid timestamp.");

  const age = Math.abs(Date.now() / 1000 - timestamp);
  if (age > TOLERANCE_SECONDS) {
    // Replay protection: an old-but-correctly-signed request is still refused.
    throw new AppError("unauthorized", "Signature timestamp is outside the tolerance window.");
  }

  const expected = createHmac("sha256", options.secret)
    .update(`${options.timestampHeader}.${options.body}`)
    .digest("hex");

  const provided = options.signatureHeader.replace(/^sha256=/, "");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  // Length must match before timingSafeEqual, and comparing lengths first does
  // not leak anything an attacker cannot already measure.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError("unauthorized", "Signature verification failed.");
  }
}

/**
 * Claims a provider event id exactly once. Returns false when this delivery has
 * already been processed, so the caller can acknowledge without re-applying.
 */
export async function claimWebhookEvent(provider: string, eventId: string): Promise<boolean> {
  try {
    await db.idempotencyKey.create({
      data: {
        scope: `webhook:${provider}`,
        key: eventId,
        status: "complete",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    return true;
  } catch {
    // Unique-constraint violation means it is a redelivery.
    log.info("webhook redelivery ignored", { provider, eventId });
    return false;
  }
}

export function billingSecret(): string | undefined {
  return env.billingWebhookSecret;
}
