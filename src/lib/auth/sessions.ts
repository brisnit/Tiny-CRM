import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { db } from "@/lib/db";
import { log } from "@/lib/logger";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Server-side session records.
 *
 * The application uses JWT sessions, which are self-contained: the server can
 * verify one without a lookup, and therefore cannot revoke one either. The
 * previous hardening report named the consequence — a stolen token stayed usable
 * for up to fourteen days, with no way to end it short of deactivating the
 * account.
 *
 * Two mechanisms close that, and they are deliberately different:
 *
 *  1. **A session id in the token, matched against a row here.** Precise: one
 *     device can be signed out without touching the others. Costs one indexed
 *     lookup per request, which is the price of revocability.
 *
 *  2. **An epoch on the user.** Blunt and free: the token carries the epoch it
 *     was minted at, and a token behind the user's current epoch is refused
 *     without any lookup at all. This is what makes "sign out everywhere",
 *     "password changed" and "account disabled" instant even if the session
 *     table is unavailable.
 *
 * Both are checked. The epoch is the backstop; the row is the product feature.
 *
 * Only a **hash** of the session id is stored, for the same reason password
 * hashes are: a leaked database should not hand over live sessions.
 */

export const SESSION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

export type RevocationReason =
  | "signed_out"
  | "signed_out_others"
  | "password_changed"
  | "role_changed"
  | "deactivated"
  | "expired"
  | "admin_revoked"
  | "mfa_enrolled";

export function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

/**
 * Truncates an address before storage.
 *
 * A session list should be able to say "somewhere else" without keeping a
 * precise movement history of the user. IPv4 keeps the /24, IPv6 the /48 —
 * enough to distinguish networks, not enough to place someone.
 */
export function truncateIp(ip: string | null | undefined): string | null {
  if (!ip || ip === "unknown") return null;

  if (ip.includes(":")) {
    const groups = ip.split(":").filter(Boolean).slice(0, 3);
    return groups.length ? `${groups.join(":")}::/48` : null;
  }

  const octets = ip.split(".");
  if (octets.length !== 4) return null;
  return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

/**
 * A short, human label from a user agent.
 *
 * Deliberately coarse. The point is for someone to recognise their own devices
 * in a list, not to fingerprint them — and the full string is stored anyway for
 * an investigation.
 */
export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";

  const browser =
    /Edg\//.test(userAgent) ? "Edge"
    : /OPR\//.test(userAgent) ? "Opera"
    : /Chrome\//.test(userAgent) ? "Chrome"
    : /Firefox\//.test(userAgent) ? "Firefox"
    : /Safari\//.test(userAgent) ? "Safari"
    : "Browser";

  const platform =
    /iPhone|iPad/.test(userAgent) ? "iOS"
    : /Android/.test(userAgent) ? "Android"
    : /Mac OS X|Macintosh/.test(userAgent) ? "macOS"
    : /Windows/.test(userAgent) ? "Windows"
    : /Linux/.test(userAgent) ? "Linux"
    : "an unknown platform";

  return `${browser} on ${platform}`;
}

export type SessionMetadata = {
  ip?: string | null;
  userAgent?: string | null;
};

/**
 * Creates a session record and returns the id to embed in the token.
 *
 * The id is returned exactly once. Only its hash is kept.
 */
export async function createSession(
  userId: string,
  metadata: SessionMetadata = {},
): Promise<{ sessionId: string; epoch: number; expiresAt: Date }> {
  const sessionId = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);

  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { sessionEpoch: true },
  });

  await db.userSession.create({
    data: {
      userId,
      tokenHash: hashSessionId(sessionId),
      expiresAt,
      ipPrefix: truncateIp(metadata.ip),
      userAgent: metadata.userAgent?.slice(0, 300) ?? null,
      deviceLabel: describeDevice(metadata.userAgent),
    },
  });

  return { sessionId, epoch: user.sessionEpoch, expiresAt };
}

export type SessionCheck =
  | { valid: true; sessionId: string }
  | { valid: false; reason: "unknown" | "revoked" | "expired" | "stale_epoch" };

/**
 * Validates a token's session claims.
 *
 * Called on every request that resolves an identity. The epoch is compared
 * first, because it needs no session row: a token minted before a "sign out
 * everywhere" is dead whatever the session table says, and a token that predates
 * the last password change is dead even if its own session was never revoked.
 */
export async function validateSession(
  userId: string,
  sessionId: string | null | undefined,
  tokenEpoch: number | null | undefined,
  issuedAt?: Date | null,
): Promise<SessionCheck> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { sessionEpoch: true, passwordChangedAt: true },
  });
  if (!user) return { valid: false, reason: "unknown" };

  if ((tokenEpoch ?? -1) < user.sessionEpoch) {
    return { valid: false, reason: "stale_epoch" };
  }

  // A token minted before the last password change is refused even if its epoch
  // happens to match — belt and braces for the one event where a stale session
  // is most dangerous.
  if (issuedAt && user.passwordChangedAt && issuedAt < user.passwordChangedAt) {
    return { valid: false, reason: "stale_epoch" };
  }

  if (!sessionId) {
    // A token minted before server-side sessions existed. Refused rather than
    // grandfathered: the whole point is that every live token is revocable.
    return { valid: false, reason: "unknown" };
  }

  const session = await db.userSession.findUnique({
    where: { tokenHash: hashSessionId(sessionId) },
    select: { id: true, userId: true, revokedAt: true, expiresAt: true },
  });

  if (!session || session.userId !== userId) return { valid: false, reason: "unknown" };
  if (session.revokedAt) return { valid: false, reason: "revoked" };
  if (session.expiresAt <= new Date()) return { valid: false, reason: "expired" };

  return { valid: true, sessionId: session.id };
}

/**
 * Records that a session was used.
 *
 * Throttled to once a minute per session: this runs on every request, and the
 * write is worth far less than the contention it would otherwise cause on a
 * busy account.
 */
const lastTouch = new Map<string, number>();

export async function touchSession(sessionId: string): Promise<void> {
  const now = Date.now();
  const previous = lastTouch.get(sessionId) ?? 0;
  if (now - previous < 60_000) return;
  lastTouch.set(sessionId, now);

  try {
    await db.userSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { lastSeenAt: new Date() },
    });
  } catch (error) {
    // Recording activity must never fail a request.
    log.debug("session touch failed", { error: String(error) });
  }
}

/** Lists a user's sessions, most recently active first. */
export async function listSessions(userId: string) {
  return db.userSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: {
      id: true, createdAt: true, lastSeenAt: true, expiresAt: true,
      ipPrefix: true, deviceLabel: true,
    },
    orderBy: { lastSeenAt: "desc" },
    take: 50,
  });
}

/** Revokes one session. Returns whether it was live. */
export async function revokeSession(
  userId: string,
  sessionId: string,
  reason: RevocationReason,
): Promise<boolean> {
  const result = await db.userSession.updateMany({
    // Scoped by userId as well as id: a session id from another account matches
    // nothing rather than being revoked.
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count > 0;
}

/**
 * Revokes every session, optionally keeping the one in use.
 *
 * Bumps the epoch as well as writing the rows. The epoch is what makes this
 * immediate — a request in flight on another instance is refused on its next
 * hop, without waiting for a cache or a session lookup.
 */
export async function revokeAllSessions(
  userId: string,
  reason: RevocationReason,
  options: { exceptSessionId?: string; tx?: Prisma.TransactionClient } = {},
): Promise<number> {
  const client = options.tx ?? db;

  const result = await client.userSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: reason },
  });

  // Bumping the epoch invalidates *every* token including the kept one, so it is
  // only done for a true sign-out-everywhere. When a session is being kept, the
  // rows are the mechanism and the caller re-mints the surviving token.
  if (!options.exceptSessionId) {
    await client.user.update({
      where: { id: userId },
      data: { sessionEpoch: { increment: 1 } },
    });
  }

  log.info("sessions revoked", { count: result.count, reason });
  return result.count;
}

/** Removes long-expired session rows. Called by the worker. */
export async function pruneSessions(olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const result = await db.userSession.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return result.count;
}
