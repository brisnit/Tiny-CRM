"use server";

import { headers } from "next/headers";
import bcrypt from "bcryptjs";

import { db } from "@/lib/db";
import {
  action, audit, guard, revalidatePathSafely, type ActionResult,
} from "@/lib/actions/base";
import { issueToken } from "@/lib/auth/tokens";
import { listSessions, revokeAllSessions, revokeSession, truncateIp } from "@/lib/auth/sessions";
import {
  consumeRecoveryCode, encryptSecret, generateRecoveryCodes, generateSecret,
  mfaStatus, provisioningUri, verifyCode, verifyUserCode,
} from "@/lib/auth/mfa";
import { raiseAlert } from "@/lib/security/alerts";
import { AppError } from "@/lib/errors";
import { appOrigin } from "@/lib/origin";
import { sendMail, verificationEmail } from "@/lib/mail";
import { clientAddress, enforceRateLimit } from "@/lib/rate-limit";
import { zId } from "@/lib/validation/common";

/**
 * Account settings for a signed-in user: verification, sessions, second factors.
 *
 * Every export here runs inside `guard()` and therefore behind authentication.
 * The *unauthenticated* half of the account lifecycle — starting a password
 * reset, completing one, following a verification link — lives in
 * `src/lib/actions/auth.ts` with sign-up, because those endpoints share a
 * property nothing here has: they must answer identically whether or not the
 * account exists, so they cannot use the shared error boundary at all.
 */

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

export async function requestEmailVerification(): Promise<ActionResult<{ sent: boolean }>> {
  return guard(() =>
    action(async (actor) => {
      if (actor.identity.emailVerifiedAt) {
        return { sent: false };
      }

      const ip = await requestIp();
      await enforceRateLimit("emailVerification", {
        ip: ip ?? "unknown",
        account: actor.identity.email,
      });

      const { token, expiresAt } = await issueToken(actor.identity.id, "email_verification", {
        requestIp: ip,
      });
      const link = `${appOrigin()}/verify-email?token=${encodeURIComponent(token)}`;
      const hours = Math.round((expiresAt.getTime() - Date.now()) / 3_600_000);

      const result = await sendMail({
        to: actor.identity.email,
        ...verificationEmail(link, hours),
      });

      await audit(actor, {
        action: "auth.verification_requested",
        summary: "Verification email requested",
        metadata: { delivered: result.delivered },
      });

      return { sent: result.delivered };
    }),
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function getActiveSessions(): Promise<
  ActionResult<{
    sessions: {
      id: string;
      device: string;
      location: string | null;
      createdAt: Date;
      lastSeenAt: Date;
      current: boolean;
    }[];
  }>
> {
  return guard(() =>
    action(async (actor) => {
      const rows = await listSessions(actor.identity.id);
      return {
        sessions: rows.map((row) => ({
          id: row.id,
          device: row.deviceLabel ?? "Unknown device",
          // A truncated network, never a precise address. Enough to recognise
          // "not me", not enough to be a movement log.
          location: row.ipPrefix,
          createdAt: row.createdAt,
          lastSeenAt: row.lastSeenAt,
          current: row.id === actor.identity.sessionId,
        })),
      };
    }),
  );
}

export async function signOutSession(sessionId: string): Promise<ActionResult<{ revoked: boolean }>> {
  return guard(() =>
    action(async (actor) => {
      const id = zId.parse(sessionId);
      // Scoped by user inside revokeSession, so a session id from another
      // account matches nothing rather than being revoked.
      const revoked = await revokeSession(actor.identity.id, id, "signed_out");

      if (revoked) {
        await audit(actor, {
          action: "auth.session_revoked",
          summary: "Signed out another session",
          metadata: { sessionId: id },
        });
      }

      revalidatePathSafely("/settings/security");
      return { revoked };
    }),
  );
}

/**
 * Signs out every session except this one.
 *
 * Does not bump the epoch — that would invalidate the current token too. The
 * session rows are the mechanism here; the epoch is reserved for events where
 * *everything* must end at once, such as a password change.
 */
export async function signOutOtherSessions(): Promise<ActionResult<{ revoked: number }>> {
  return guard(() =>
    action(async (actor) => {
      const revoked = await revokeAllSessions(actor.identity.id, "signed_out_others", {
        exceptSessionId: actor.identity.sessionId ?? undefined,
      });

      await audit(actor, {
        action: "auth.sessions_revoked",
        summary: `Signed out ${revoked} other session${revoked === 1 ? "" : "s"}`,
        metadata: { revoked },
      });

      revalidatePathSafely("/settings/security");
      return { revoked };
    }),
  );
}

// ---------------------------------------------------------------------------
// Two-factor authentication
// ---------------------------------------------------------------------------

export async function getMfaStatus(): Promise<
  ActionResult<Awaited<ReturnType<typeof mfaStatus>>>
> {
  return guard(() => action(async (actor) => mfaStatus(actor.identity.id)));
}

/**
 * Begins enrolment: generates a secret and returns it once, for a QR code.
 *
 * The credential is stored unconfirmed. It does not affect sign-in until
 * `confirmMfa` proves the user can actually generate a code — otherwise a
 * mis-scanned QR would lock someone out of their own account.
 */
export async function beginMfaEnrolment(): Promise<
  ActionResult<{ secret: string; uri: string }>
> {
  return guard(() =>
    action(
      async (actor) => {
        const status = await mfaStatus(actor.identity.id);
        if (status.confirmed) {
          throw new AppError("conflict", "Two-factor authentication is already on.");
        }

        const secret = generateSecret();
        await db.mfaCredential.upsert({
          where: { userId_type: { userId: actor.identity.id, type: "totp" } },
          create: {
            userId: actor.identity.id,
            type: "totp",
            secretEncrypted: encryptSecret(secret),
          },
          update: {
            // Restarting enrolment replaces the pending secret, so an abandoned
            // half-enrolment cannot be completed later from an old QR code.
            secretEncrypted: encryptSecret(secret),
            confirmedAt: null,
            lastUsedStep: null,
          },
        });

        return { secret, uri: provisioningUri(secret, actor.identity.email) };
      },
      { rateLimit: "mutation" },
    ),
  );
}

export async function confirmMfaEnrolment(
  code: string,
): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  return guard(() =>
    action(async (actor) => {
      const ip = await requestIp();
      await enforceRateLimit("mfaChallenge", {
        ip: ip ?? "unknown",
        account: actor.identity.email,
      });

      const credential = await db.mfaCredential.findUnique({
        where: { userId_type: { userId: actor.identity.id, type: "totp" } },
        select: { id: true, secretEncrypted: true, confirmedAt: true },
      });
      if (!credential) throw new AppError("not_found", "Start setting up two-factor first.");
      if (credential.confirmedAt) {
        throw new AppError("conflict", "Two-factor authentication is already on.");
      }

      const { decryptSecret } = await import("@/lib/auth/mfa");
      const result = verifyCode(decryptSecret(credential.secretEncrypted), code);
      if (!result.ok) {
        throw new AppError("validation", "That code is not right. Try the current one.", {
          meta: { field: "code" },
        });
      }

      await db.mfaCredential.update({
        where: { id: credential.id },
        data: { confirmedAt: new Date(), lastUsedStep: result.step },
      });
      await db.user.update({
        where: { id: actor.identity.id },
        data: { mfaEnabledAt: new Date() },
      });

      const recoveryCodes = await generateRecoveryCodes(actor.identity.id);

      await audit(actor, {
        action: "auth.mfa_enabled",
        summary: "Two-factor authentication enabled",
      });
      await raiseAlert({
        kind: "mfa.enabled",
        severity: "info",
        userId: actor.identity.id,
        summary: "Two-factor authentication was enabled",
        dedupeKey: `mfa-enabled:${actor.identity.id}`,
      });

      revalidatePathSafely("/settings/security");
      // Returned exactly once. Only hashes are stored.
      return { recoveryCodes };
    }),
  );
}

/**
 * Turns off two-factor authentication.
 *
 * Requires the current password *and* a valid code or recovery code. Anything
 * less would make a stolen session enough to remove the control that a stolen
 * session is supposed to be stopped by.
 */
export async function disableMfa(input: {
  password: string;
  code: string;
}): Promise<ActionResult<{ disabled: true }>> {
  return guard(() =>
    action(async (actor) => {
      const ip = await requestIp();
      await enforceRateLimit("mfaChallenge", {
        ip: ip ?? "unknown",
        account: actor.identity.email,
      });

      const user = await db.user.findUniqueOrThrow({
        where: { id: actor.identity.id },
        select: { passwordHash: true },
      });
      if (!user.passwordHash || !(await bcrypt.compare(input.password, user.passwordHash))) {
        throw new AppError("forbidden", "That password is not right.", {
          meta: { field: "password" },
        });
      }

      const byCode = await verifyUserCode(actor.identity.id, input.code);
      const byRecovery = byCode.ok
        ? false
        : await consumeRecoveryCode(actor.identity.id, input.code);
      if (!byCode.ok && !byRecovery) {
        throw new AppError("validation", "That code is not right.", { meta: { field: "code" } });
      }

      await db.$transaction(async (tx) => {
        await tx.mfaCredential.deleteMany({ where: { userId: actor.identity.id } });
        await tx.mfaRecoveryCode.deleteMany({ where: { userId: actor.identity.id } });
        await tx.user.update({
          where: { id: actor.identity.id },
          data: { mfaEnabledAt: null },
        });
      });

      await audit(actor, {
        action: "auth.mfa_disabled",
        summary: "Two-factor authentication disabled",
      });
      await raiseAlert({
        kind: "mfa.disabled",
        severity: "warning",
        userId: actor.identity.id,
        summary: "Two-factor authentication was turned off",
        dedupeKey: `mfa-disabled:${actor.identity.id}:${Date.now()}`,
      });

      revalidatePathSafely("/settings/security");
      return { disabled: true as const };
    }),
  );
}

export async function regenerateRecoveryCodes(
  code: string,
): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  return guard(() =>
    action(async (actor) => {
      const ip = await requestIp();
      await enforceRateLimit("mfaChallenge", {
        ip: ip ?? "unknown",
        account: actor.identity.email,
      });

      const verified = await verifyUserCode(actor.identity.id, code);
      if (!verified.ok) {
        throw new AppError("validation", "That code is not right.", { meta: { field: "code" } });
      }

      const recoveryCodes = await generateRecoveryCodes(actor.identity.id);
      await audit(actor, {
        action: "auth.mfa_recovery_regenerated",
        summary: "Recovery codes regenerated; the previous set stopped working",
      });

      revalidatePathSafely("/settings/security");
      return { recoveryCodes };
    }),
  );
}

// ---------------------------------------------------------------------------

async function requestIp(): Promise<string | null> {
  try {
    return truncateIp(clientAddress(await headers()));
  } catch {
    return null;
  }
}
