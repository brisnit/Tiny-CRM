"use server";

import bcrypt from "bcryptjs";
import { headers } from "next/headers";
import { z } from "zod";

import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import {
  PASSWORD_HASH_COST,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  passwordByteLength,
} from "@/lib/auth/password";
import { revokeAllSessions, truncateIp } from "@/lib/auth/sessions";
import { issueToken, redeemToken, revokeTokens } from "@/lib/auth/tokens";
import { appOrigin } from "@/lib/origin";
import { log } from "@/lib/logger";
import { passwordChangedEmail, passwordResetEmail, sendMail, verificationEmail } from "@/lib/mail";
import { raiseAlert } from "@/lib/security/alerts";
import { clientAddress, checkRateLimit } from "@/lib/rate-limit";
import { zEmail, zShortText } from "@/lib/validation/common";

/**
 * Sign-up.
 *
 * This is the only unauthenticated write in the application, so it is the one
 * that has to be careful about what it reveals.
 *
 *  - **Account existence is never disclosed.** A duplicate email produces the
 *    same success response as a new one; the account simply is not created a
 *    second time. Telling an anonymous caller "that email already exists" turns
 *    this endpoint into an account-enumeration oracle, which is exactly what the
 *    sign-in path already refuses to be.
 *  - It is rate limited by client address, so the same oracle cannot be
 *    rebuilt through timing at volume.
 *  - Passwords are hashed with bcrypt at the application's configured cost
 *    before storage; the plaintext is never logged or audited.
 */

/**
 * The one password rule, shared by sign-up and reset so the two cannot drift.
 *
 * The upper bound is measured in bytes rather than characters because that is
 * the unit bcrypt truncates on; see PASSWORD_MAX_BYTES. This is the
 * authoritative check. The `maxLength` attributes in the forms are a UX
 * convenience and are counted in a different unit, so they neither replace this
 * nor can they reject something this would have allowed.
 */
const zPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .refine((value) => passwordByteLength(value) <= PASSWORD_MAX_BYTES, {
    message:
      `That password is too long — the limit is ${PASSWORD_MAX_BYTES} bytes. ` +
      "Most characters count as one, but accented letters and emoji count as several.",
  });

const signUpSchema = z.object({
  name: zShortText.min(1, "What should we call you?"),
  email: zEmail,
  password: zPassword,
});

export type SignUpResult = { ok: true } | { ok: false; error: string; field?: string };


/**
 * Issues a verification token and mails the link.
 *
 * Deliberately never throws. A provider outage must not lose the account that
 * was just created — the address simply stays unverified and the owner can ask
 * for another link. Failing the sign-up instead would turn a transient mail
 * problem into a registration the user has to repeat with no idea why.
 *
 * `issueToken` supersedes any earlier verification token for the account, so
 * asking again invalidates the previous link rather than leaving two live.
 */
async function sendVerificationEmail(
  userId: string,
  email: string,
  ip: string | null,
): Promise<{ sent: boolean }> {
  try {
    const { token, expiresAt } = await issueToken(userId, "email_verification", { requestIp: ip });
    const link = `${appOrigin()}/verify-email?token=${encodeURIComponent(token)}`;
    const hours = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 3_600_000));
    const result = await sendMail({ to: email, ...verificationEmail(link, hours) });
    if (!result.delivered) {
      log.error("verification email could not be delivered", { adapter: result.adapter });
    }
    return { sent: result.delivered };
  } catch (error) {
    log.error("verification email failed", { error: error instanceof Error ? error.message : "unknown" });
    return { sent: false };
  }
}

export async function signUp(input: z.input<typeof signUpSchema>): Promise<SignUpResult> {
  const parsed = signUpSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.message ?? "Check the form", field: issue?.path.join(".") };
  }

  const { name, email, password } = parsed.data;

  let ip: string | null = null;
  try {
    ip = clientAddress(await headers());
  } catch {
    // No request scope (tests, scripts).
  }

  const limit = await checkRateLimit("signup", { ip: ip ?? "unknown" });
  if (!limit.ok) {
    return { ok: false, error: "Too many attempts. Try again in a few minutes." };
  }

  const existing = await db.user.findUnique({ where: { email }, select: { id: true } });

  if (existing) {
    // Burn comparable time to the hash below so the response time does not
    // separate "taken" from "available", then answer identically.
    await bcrypt.hash(password, PASSWORD_HASH_COST);
    await recordAudit({
      action: "auth.signed_up",
      actorEmail: email,
      summary: "Sign-up attempted for an existing account",
      metadata: { outcome: "duplicate" },
      ip,
    });
    return { ok: true };
  }

  const user = await db.user.create({
    data: {
      email,
      name,
      passwordHash: await bcrypt.hash(password, PASSWORD_HASH_COST),
      plan: "free",
    },
    select: { id: true },
  });

  await sendVerificationEmail(user.id, email, ip);

  await recordAudit({
    actorId: user.id,
    actorEmail: email,
    action: "auth.signed_up",
    summary: "Created an account",
    ip,
  });
  log.info("account created");

  // The workspace is created during onboarding, not here, so the first screen
  // after sign-up can ask what the user actually runs.
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

const requestResetSchema = z.object({ email: zEmail });

export type ResetRequestResult = { ok: true };

/**
 * Starts a password reset.
 *
 * Always reports success. When the address has no account, no token is issued
 * and no mail is sent — but a bcrypt hash is computed anyway, so the two paths
 * cost roughly the same. The caller cannot tell them apart.
 */
export async function requestPasswordReset(
  input: z.input<typeof requestResetSchema>,
): Promise<ResetRequestResult> {
  const parsed = requestResetSchema.safeParse(input);
  // Even a malformed address gets the same answer, for the same reason.
  if (!parsed.success) return { ok: true };

  const { email } = parsed.data;
  const ip = await requestIp();

  // Two axes: a flood from one host, and a flood aimed at one inbox. The second
  // matters as much as the first — repeated reset mail to someone else's address
  // is harassment whether or not it ever succeeds.
  const limit = await checkRateLimit("passwordReset", { ip: ip ?? "unknown", account: email });
  if (!limit.ok) {
    // Still reports success: a rate-limit message keyed to an address would
    // itself distinguish a real account from an invented one under load.
    log.warn("password reset throttled");
    return { ok: true };
  }

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, email: true, deactivatedAt: true },
  });

  if (!user || user.deactivatedAt) {
    // Equivalent work to the branch below, so the response time does not answer
    // the question the response refuses to.
    await bcrypt.hash(email, 10);
    await recordAudit({
      action: "auth.password_reset_requested",
      actorEmail: email,
      summary: "Password reset requested for an address with no active account",
      metadata: { outcome: "no_account" },
      ip,
    });
    return { ok: true };
  }

  const { token, expiresAt } = await issueToken(user.id, "password_reset", { requestIp: ip });
  const link = `${appOrigin()}/reset-password?token=${encodeURIComponent(token)}`;
  const minutes = Math.round((expiresAt.getTime() - Date.now()) / 60_000);

  const result = await sendMail({ to: user.email, ...passwordResetEmail(link, minutes) });
  if (!result.delivered) {
    log.error("password reset email could not be delivered", { adapter: result.adapter });
  }

  await recordAudit({
    actorId: user.id,
    actorEmail: user.email,
    action: "auth.password_reset_requested",
    summary: "Password reset requested",
    metadata: { delivered: result.delivered },
    ip,
  });

  return { ok: true };
}

const resetSchema = z.object({
  token: z.string().trim().min(20).max(200),
  password: zPassword,
});

export type ResetResult = { ok: true } | { ok: false; error: string; field?: string };

/**
 * Completes a password reset.
 *
 * On success: the password changes, every outstanding token for the account is
 * revoked, **every session is revoked**, and the owner is told by email. The
 * session revocation is the part that matters — a reset that left the attacker's
 * session alive would change the lock while they were already inside.
 */
export async function resetPassword(input: z.input<typeof resetSchema>): Promise<ResetResult> {
  const parsed = resetSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.message ?? "Check the form", field: issue?.path.join(".") };
  }

  const ip = await requestIp();
  const hash = await bcrypt.hash(parsed.data.password, PASSWORD_HASH_COST);

  const redemption = await redeemToken(parsed.data.token, "password_reset", async (userId, tx) => {
    const now = new Date();

    await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash: hash,
        passwordChangedAt: now,
        // Clears any lockout: the person proved control of the inbox, and
        // leaving them locked out would be a denial of service on themselves.
        failedLoginCount: 0,
        lockedUntil: null,
        // Completing a reset proves the address works, so it verifies it too.
        emailVerifiedAt: now,
      },
    });

    // Any other outstanding reset or verification link is dead.
    await revokeTokens(userId, tx);

    // Every session, including the one that requested this. Bumps the epoch, so
    // a token in flight on another instance is refused on its next request.
    await revokeAllSessions(userId, "password_changed", { tx });

    return { userId };
  });

  if (!redemption.ok) {
    // One message for every failure mode. "Already used" versus "expired" tells
    // an attacker holding a stale link whether it was ever real.
    await recordAudit({
      action: "auth.password_reset_completed",
      summary: "Password reset refused",
      metadata: { outcome: redemption.reason },
      ip,
    });
    return {
      ok: false,
      error: "That reset link is no longer valid. Request a new one.",
      field: "token",
    };
  }

  const user = await db.user.findUnique({
    where: { id: redemption.userId },
    select: { email: true },
  });

  if (user) {
    // Notifies the real owner, and carries no link — so it is safe even when the
    // attacker also controls the inbox.
    await sendMail({ to: user.email, ...passwordChangedEmail(new Date()) });
  }

  await recordAudit({
    actorId: redemption.userId,
    actorEmail: user?.email ?? null,
    action: "auth.password_reset_completed",
    summary: "Password reset completed; all sessions revoked",
    ip,
  });

  await raiseAlert({
    kind: "password.reset_completed",
    severity: "info",
    userId: redemption.userId,
    summary: "A password was reset and every session revoked",
    dedupeKey: `password-reset:${redemption.userId}:${new Date().toISOString().slice(0, 13)}`,
  });

  return { ok: true };
}

export type VerifyResult = { ok: true } | { ok: false; error: string };

/**
 * Confirms an email address.
 *
 * Unauthenticated: the link is followed from an inbox, which may not be the
 * browser that is signed in. The token is the proof.
 */
export async function verifyEmail(token: string): Promise<VerifyResult> {
  const parsed = z.string().trim().min(20).max(200).safeParse(token);
  if (!parsed.success) return { ok: false, error: "That link is not valid." };

  const redemption = await redeemToken(parsed.data, "email_verification", async (userId, tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { emailVerifiedAt: new Date() },
    });
    return { userId };
  });

  if (!redemption.ok) {
    return { ok: false, error: "That link is no longer valid. Request a new one from Settings." };
  }

  await recordAudit({
    actorId: redemption.userId,
    action: "auth.email_verified",
    summary: "Email address confirmed",
    ip: await requestIp(),
  });

  return { ok: true };
}

async function requestIp(): Promise<string | null> {
  try {
    return truncateIp(clientAddress(await headers()));
  } catch {
    return null;
  }
}

const resendSchema = z.object({ email: zEmail });

export type ResendResult = { ok: true };

/**
 * Sends another verification link.
 *
 * Answers identically whatever the address is, for the same reason
 * `requestPasswordReset` does: a different response for a known account turns
 * this into an account-existence oracle. Rate limited on both axes — a flood
 * from one host, and a flood aimed at one inbox, the second being harassment
 * whether or not it ever succeeds.
 */
export async function resendVerification(
  input: z.input<typeof resendSchema>,
): Promise<ResendResult> {
  const parsed = resendSchema.safeParse(input);
  if (!parsed.success) return { ok: true };

  const { email } = parsed.data;
  const ip = await requestIp();

  const limit = await checkRateLimit("emailVerification", { ip: ip ?? "unknown", account: email });
  if (!limit.ok) {
    log.warn("verification resend throttled");
    return { ok: true };
  }

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, email: true, emailVerifiedAt: true, deactivatedAt: true },
  });

  // Already verified, absent, or deactivated all take the same path out: there
  // is nothing to send, and saying so would answer the question.
  if (!user || user.deactivatedAt || user.emailVerifiedAt) {
    await bcrypt.hash(email, 10);
    return { ok: true };
  }

  await sendVerificationEmail(user.id, user.email, ip);
  return { ok: true };
}

/**
 * The reset form's action, taking FormData.
 *
 * ---------------------------------------------------------------------------
 * The bug this exists to fix
 * ---------------------------------------------------------------------------
 *
 * The reset form's only working submit path was React's `onSubmit`. Anything
 * that submitted it another way — which is exactly what Chrome does after
 * "Use Strong Password", and why it then offers "Update password?" — never ran
 * `preventDefault()`, so the browser posted the form to the page itself. Next
 * answers that with 200 and renders the page again, so the person landed back
 * on a freshly rendered, **empty** reset form with the token still in the URL,
 * and could repeat it forever. The token was never consumed, which is the one
 * mercy in it: nothing was spent, so nothing was lost except the ability to
 * finish.
 *
 * Reproduced in Chromium by submitting the form without firing the submit
 * event. A form action fixes the class rather than the symptom: the submission
 * is handled wherever it comes from — React, a password manager, or a browser
 * with no JavaScript at all — because the server receives the POST and acts on
 * it instead of re-rendering a blank form.
 *
 * The first attempt at that fix was wrong in a way worth recording. React
 * clobbering the autofilled value *was* real — an earlier run said otherwise,
 * but it forced re-renders with blur and resize events, which do not re-render
 * a component whose state has not changed, so it never exercised the path. The
 * fix for the blank form introduced controlled inputs; React's input
 * reconciliation compares its prop against the live DOM value, so the empty
 * state overwrote Chrome's generated password the moment the action started.
 * The form is uncontrolled again, and has one password field rather than two —
 * see the component for why the second field is what made state look necessary.
 *
 * There is deliberately no confirm-password check here any more. It was not a
 * security boundary, and its only failure mode was the one that wiped the form.
 *
 * Everything security-relevant stays in `resetPassword` below it: token
 * hashing, expiry, single use, session revocation, the notification email and
 * the identical answers that keep the endpoint non-enumerable.
 */
export async function resetPasswordAction(
  _previous: ResetResult | null,
  formData: FormData,
): Promise<ResetResult> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");

  // Length and byte-length are enforced by `resetSchema` inside `resetPassword`,
  // so they hold for a submission that arrives without JavaScript too.
  return resetPassword({ token, password });
}
