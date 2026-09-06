import "server-only";

import {
  createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual,
} from "node:crypto";

import bcrypt from "bcryptjs";

import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/logger";

/**
 * Time-based one-time passwords (RFC 6238).
 *
 * **Status: the mechanism is complete and tested; it is not yet wired into
 * sign-in.** Enrolling, confirming, verifying, recovery codes and disabling all
 * work and are covered by tests. What is missing is the sign-in step that
 * *demands* a code — see the note at the bottom of this file and the entry in
 * docs/PRODUCTION-READINESS.md. MFA is therefore reported as a foundation, not
 * as a shipped control.
 *
 * Implemented here rather than pulled in as a dependency: TOTP is a HMAC and a
 * modulo, the whole algorithm is thirty lines, and the security-relevant parts
 * are the ones a library would not decide for us anyway — how the secret is
 * stored, how wide the window is, and whether a code can be replayed.
 *
 * The decisions that matter:
 *
 *  - **The secret is encrypted at rest**, with a key derived from `AUTH_SECRET`.
 *    A database copy alone does not yield working codes. This is encryption, not
 *    hashing, because the server must reproduce the code to check it.
 *  - **±1 step of drift** (30 seconds either way). Wider is friendlier and
 *    multiplies the guessing surface; this is the usual compromise.
 *  - **A used step cannot be reused.** Without this, a code observed over the
 *    user's shoulder — or captured by a phishing proxy — stays valid for the
 *    rest of its window.
 *  - **Recovery codes are bcrypt-hashed**, because they are credentials with far
 *    less entropy than a session id and are typed by hand.
 */

const DIGITS = 6;
const STEP_SECONDS = 30;
/** How many steps either side of now are accepted. */
const DRIFT = 1;
const RECOVERY_CODE_COUNT = 10;

// ---------------------------------------------------------------------------
// Secret storage
// ---------------------------------------------------------------------------

/**
 * A stable key from the session secret.
 *
 * scrypt with a fixed salt: the input is already high-entropy, so the salt's
 * usual job (defeating precomputation against low-entropy inputs) does not
 * apply, and a fixed one keeps the derivation deterministic across instances.
 */
function encryptionKey(): Buffer {
  return scryptSync(env.authSecret, "tiny-crm/mfa/v1", 32);
}

export function encryptSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // GCM, so a tampered ciphertext fails to decrypt rather than yielding garbage.
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptSecret(stored: string): string {
  const [version, ivPart, tagPart, dataPart] = stored.split(".");
  if (version !== "v1" || !ivPart || !tagPart || !dataPart) {
    throw new AppError("internal", "Two-factor authentication is unavailable.", {
      internal: "unrecognised MFA secret format",
    });
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivPart, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

// ---------------------------------------------------------------------------
// The algorithm
// ---------------------------------------------------------------------------

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateSecret(): string {
  // 20 bytes is the RFC 4226 recommendation and what every authenticator expects.
  const bytes = randomBytes(20);
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");

  let secret = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    secret += BASE32[parseInt(bits.slice(i, i + 5), 2)];
  }
  return secret;
}

function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) continue;
    bits += index.toString(2).padStart(5, "0");
  }

  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function currentStep(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 1000 / STEP_SECONDS);
}

/** The code for one time step. Exported so tests can generate valid codes. */
export function codeForStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  // Dynamic truncation, RFC 4226 §5.4.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

/** The `otpauth://` URI an authenticator scans. */
export function provisioningUri(secret: string, account: string, issuer = "Tiny CRM"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Verifies a code, returning the step it matched.
 *
 * `lastUsedStep` is the replay guard: a step at or below the last accepted one
 * is refused even when the arithmetic is correct.
 */
export function verifyCode(
  secret: string,
  code: string,
  options: { at?: Date; lastUsedStep?: number | null } = {},
): { ok: true; step: number } | { ok: false; reason: "malformed" | "invalid" | "replayed" } {
  const cleaned = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(cleaned)) return { ok: false, reason: "malformed" };

  const now = currentStep(options.at);
  for (let offset = -DRIFT; offset <= DRIFT; offset++) {
    const step = now + offset;
    const expected = codeForStep(secret, step);

    // Constant-time: a byte-by-byte comparison of a six-digit code is a
    // small leak, but it is a free one to close.
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(cleaned, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) continue;

    if (options.lastUsedStep != null && step <= options.lastUsedStep) {
      return { ok: false, reason: "replayed" };
    }
    return { ok: true, step };
  }

  return { ok: false, reason: "invalid" };
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/** Generates codes and stores only their hashes. Plaintext is shown once. */
export async function generateRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    // Grouped for legibility; the hyphen is not part of the entropy.
    `${randomBytes(4).toString("hex")}-${randomBytes(4).toString("hex")}`,
  );

  await db.$transaction(async (tx) => {
    // Regenerating replaces the whole set, so a code printed earlier and left in
    // a drawer stops working.
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    for (const code of codes) {
      await tx.mfaRecoveryCode.create({
        data: { userId, codeHash: await bcrypt.hash(code, 10) },
      });
    }
  });

  return codes;
}

/**
 * Consumes a recovery code.
 *
 * Every unused code is compared, so a wrong code costs the same as a right one
 * and the response time does not reveal how many remain.
 */
export async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const cleaned = code.trim().toLowerCase();
  const candidates = await db.mfaRecoveryCode.findMany({
    where: { userId, usedAt: null },
    select: { id: true, codeHash: true },
  });

  let matched: string | null = null;
  for (const candidate of candidates) {
    if (await bcrypt.compare(cleaned, candidate.codeHash)) matched = candidate.id;
  }
  if (!matched) return false;

  const claimed = await db.mfaRecoveryCode.updateMany({
    where: { id: matched, usedAt: null },
    data: { usedAt: new Date() },
  });
  return claimed.count > 0;
}

export async function remainingRecoveryCodes(userId: string): Promise<number> {
  return db.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
}

// ---------------------------------------------------------------------------
// Enrolment state
// ---------------------------------------------------------------------------

export async function mfaStatus(userId: string): Promise<{
  enrolled: boolean;
  confirmed: boolean;
  recoveryCodesRemaining: number;
  enforcedAtSignIn: boolean;
}> {
  const [credential, remaining] = await Promise.all([
    db.mfaCredential.findUnique({
      where: { userId_type: { userId, type: "totp" } },
      select: { confirmedAt: true },
    }),
    remainingRecoveryCodes(userId),
  ]);

  return {
    enrolled: Boolean(credential),
    confirmed: Boolean(credential?.confirmedAt),
    recoveryCodesRemaining: remaining,
    // Stated explicitly rather than implied. See the note below.
    enforcedAtSignIn: MFA_ENFORCED_AT_SIGN_IN,
  };
}

/**
 * Whether a confirmed second factor is demanded during sign-in.
 *
 * **Currently false, deliberately and visibly.**
 *
 * Everything above is complete: enrolment, confirmation, drift, replay
 * protection, recovery codes, encrypted secrets, audit events. What remains is
 * the sign-in step itself, and it is not a small change to make safely: the
 * Credentials provider authorises in one call, so demanding a second factor
 * means either a two-stage sign-in with a short-lived pre-auth token, or moving
 * to a provider that models a challenge natively.
 *
 * Shipping a half-wired version would be worse than shipping none — a user who
 * enrols and believes they are protected, but is not, is in a more dangerous
 * position than one who knows they are not. So the capability is exposed as
 * enrolment only, this flag says so, `mfaStatus()` returns it to the UI, and
 * the scorecard reports MFA as a foundation rather than as a control.
 */
export const MFA_ENFORCED_AT_SIGN_IN = false;

export async function requireMfaChallenge(userId: string): Promise<boolean> {
  if (!MFA_ENFORCED_AT_SIGN_IN) return false;
  const credential = await db.mfaCredential.findUnique({
    where: { userId_type: { userId, type: "totp" } },
    select: { confirmedAt: true },
  });
  return Boolean(credential?.confirmedAt);
}

/** Verifies a code against a user's stored credential and records the step. */
export async function verifyUserCode(
  userId: string,
  code: string,
): Promise<{ ok: boolean; reason?: string }> {
  const credential = await db.mfaCredential.findUnique({
    where: { userId_type: { userId, type: "totp" } },
    select: { id: true, secretEncrypted: true, lastUsedStep: true, confirmedAt: true },
  });
  if (!credential) return { ok: false, reason: "not_enrolled" };

  let secret: string;
  try {
    secret = decryptSecret(credential.secretEncrypted);
  } catch (error) {
    log.error("could not decrypt an MFA secret", { error: String(error) });
    return { ok: false, reason: "unavailable" };
  }

  const result = verifyCode(secret, code, { lastUsedStep: credential.lastUsedStep });
  if (!result.ok) return { ok: false, reason: result.reason };

  // Conditional on the step still being the one we read, so two concurrent
  // submissions of the same code cannot both succeed.
  const claimed = await db.mfaCredential.updateMany({
    where: { id: credential.id, lastUsedStep: credential.lastUsedStep },
    data: { lastUsedStep: result.step, lastUsedAt: new Date() },
  });
  if (claimed.count === 0) return { ok: false, reason: "replayed" };

  return { ok: true };
}
