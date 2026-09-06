import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { db } from "@/lib/db";
import { log } from "@/lib/logger";
import type { Prisma } from "@/generated/prisma/client";

/**
 * One-time tokens for password reset and email verification.
 *
 * The properties that make these safe, and where each is enforced:
 *
 *  - **Unguessable.** 32 bytes from the CSPRNG, base64url. Not a UUID: a v4
 *    UUID has 122 bits, which is fine, but `randomUUID` is easy to swap for a
 *    v7 or a timestamp variant by someone who does not know why it mattered.
 *  - **Only the hash is stored.** A database copy yields no usable token. SHA-256
 *    without a salt is correct here and *not* the same mistake as unsalted
 *    password hashing: the input has 256 bits of entropy, so there is no
 *    dictionary to precompute.
 *  - **Single use.** Consumption is a conditional `updateMany` on `usedAt IS
 *    NULL`, so two simultaneous redemptions cannot both win.
 *  - **Short-lived.** 30 minutes for a reset, 24 hours for a verification.
 *  - **Superseded on issue.** Requesting a new reset invalidates every earlier
 *    one, so a link forwarded or leaked earlier stops working.
 *  - **Invalidated on use.** A completed reset revokes every outstanding token
 *    for that account, of any purpose.
 *
 * The token is returned to the caller exactly once, to put in an email. It is
 * never logged, never returned by an action, and never stored.
 */

export const TOKEN_PURPOSES = ["password_reset", "email_verification"] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

export const TOKEN_LIFETIME_MS: Record<TokenPurpose, number> = {
  // Short: a reset link is a bearer credential for the account, and the window
  // in which a leaked one is useful should be minutes, not days.
  password_reset: 30 * 60 * 1000,
  // Longer: verification is not a credential for anything, and people read
  // their email on their own schedule.
  email_verification: 24 * 60 * 60 * 1000,
};

/** Hashes a token for storage and lookup. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Issues a token, superseding any earlier one for the same purpose.
 *
 * Returns the plaintext, which the caller must put in an email and then forget.
 */
export async function issueToken(
  userId: string,
  purpose: TokenPurpose,
  options: { requestIp?: string | null } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS[purpose]);

  await db.$transaction(async (tx) => {
    // A newly requested link supersedes every earlier one. Without this, a
    // link mailed an hour ago — perhaps to an inbox that has since been
    // compromised — stays valid alongside the new one.
    await tx.authToken.updateMany({
      where: { userId, purpose, usedAt: null },
      data: { usedAt: new Date() },
    });

    await tx.authToken.create({
      data: { userId, purpose, tokenHash, expiresAt, requestIp: options.requestIp ?? null },
    });
  });

  return { token, expiresAt };
}

export type TokenFailure = "not_found" | "expired" | "already_used";

export type TokenRedemption<T> =
  | { ok: true; result: T; userId: string }
  | { ok: false; reason: TokenFailure };

/**
 * Redeems a token, atomically and once.
 *
 * The caller does the actual work (setting a password, marking an address
 * verified) inside `fn`, in the same transaction — so a failure there leaves the
 * token unconsumed rather than burning it on a change that did not happen.
 */
export async function redeemToken<T>(
  token: string,
  purpose: TokenPurpose,
  fn: (userId: string, tx: Prisma.TransactionClient) => Promise<T>,
): Promise<TokenRedemption<T>> {
  const tokenHash = hashToken(token);

  try {
    return await db.$transaction(async (tx) => {
      const record = await tx.authToken.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, purpose: true, expiresAt: true, usedAt: true },
      });

      // Compare the purpose in constant time as well. An attacker who somehow
      // has a verification token should not be able to learn, by timing, that
      // it is valid-but-wrong-purpose rather than simply unknown.
      const purposeMatches = record ? safeEqual(record.purpose, purpose) : false;
      if (!record || !purposeMatches) return { ok: false as const, reason: "not_found" as const };
      if (record.usedAt) return { ok: false as const, reason: "already_used" as const };
      if (record.expiresAt <= new Date()) return { ok: false as const, reason: "expired" as const };

      // Conditional update: only one concurrent redemption can match.
      const claimed = await tx.authToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) return { ok: false as const, reason: "already_used" as const };

      const result = await fn(record.userId, tx);
      return { ok: true as const, result, userId: record.userId };
    });
  } catch (error) {
    log.error("token redemption failed", { purpose, error: String(error) });
    throw error;
  }
}

/**
 * Invalidates every outstanding token for an account.
 *
 * Called after a successful password reset. A reset that left an older
 * verification or reset token alive would leave a second door open to the
 * account it just secured.
 */
export async function revokeTokens(
  userId: string,
  tx?: Prisma.TransactionClient,
): Promise<number> {
  const client = tx ?? db;
  const result = await client.authToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });
  return result.count;
}

/** Removes expired and consumed tokens. Called by the worker. */
export async function pruneTokens(olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const result = await db.authToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: cutoff } }, { usedAt: { lt: cutoff } }] },
  });
  return result.count;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
