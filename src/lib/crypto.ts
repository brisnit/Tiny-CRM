import "server-only";

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";

/**
 * Authenticated encryption for secrets this product stores on a customer's
 * behalf — today, OAuth tokens for an email or calendar connection.
 *
 * ## Why this file exists at all
 *
 * `prisma/schema.prisma` has claimed since the integration models were added
 * that `Integration.credentials` is "Encrypted at rest by src/lib/crypto.ts".
 * There was no such module. The column existed and nothing ever wrote it, so
 * the claim was true only in the sense that nothing had yet been stored
 * unencrypted. The Settings screen repeated it to customers. This is the
 * module that makes it true before a real token ever lands there.
 *
 * ## What it is, and what it is not
 *
 * AES-256-GCM with a random 96-bit IV per message and the auth tag retained,
 * so a tampered ciphertext fails to decrypt rather than returning plausible
 * bytes. The same construction as `src/lib/auth/mfa.ts`, which has stored
 * TOTP secrets this way in production — deliberately the same, because a
 * second hand-rolled scheme is a second chance to get one wrong.
 *
 * It is **not** a key-management system. The key is derived from
 * `AUTH_SECRET`, which means:
 *
 *   - rotating `AUTH_SECRET` makes every stored token undecryptable. That is
 *     survivable for this data — a connection can be re-authorised, and
 *     `decryptSecret` surfaces the failure as a reconnect prompt rather than a
 *     crash — but it is not survivable for anything that cannot be re-created,
 *     so nothing irreplaceable should be stored with this.
 *   - the key lives in the same process as the data. An attacker with code
 *     execution has both. What this defends against is the realistic case: a
 *     database backup, a logical dump, a leaked read replica, a support
 *     engineer with SQL access.
 *
 * ## Domain separation
 *
 * The scrypt salt names the purpose, so the key that encrypts OAuth tokens is
 * not the key that encrypts MFA secrets even though both derive from
 * `AUTH_SECRET`. Without that, a ciphertext from one store would decrypt in
 * the other, and a confused-deputy bug could swap them silently.
 */

/** Purposes, each with its own derived key. Add a case rather than a salt. */
export type SecretPurpose = "integration-credentials";

const SALTS: Record<SecretPurpose, string> = {
  "integration-credentials": "tiny-crm/integration-credentials/v1",
};

/**
 * scrypt with a fixed, purpose-naming salt.
 *
 * A fixed salt is correct here for the same reason it is in mfa.ts: the input
 * is already high-entropy, so the salt's usual job — defeating precomputation
 * against guessable inputs — does not apply, and a deterministic derivation is
 * what lets any instance decrypt what another wrote.
 */
function keyFor(purpose: SecretPurpose): Buffer {
  return scryptSync(env.authSecret, SALTS[purpose], 32);
}

/** `v1.<purpose>.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptSecret(plaintext: string, purpose: SecretPurpose): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(purpose), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    purpose,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Thrown when stored ciphertext cannot be read: wrong key, wrong purpose,
 * tampering, or truncation.
 *
 * Its own class so a caller can tell "this connection needs re-authorising"
 * from "the database is unreachable". The two call for different UI and only
 * one of them is an incident.
 */
export class SecretUnreadableError extends AppError {
  constructor(reason: string) {
    super("internal", "That connection needs to be reconnected.", { internal: reason });
    this.name = "SecretUnreadableError";
  }
}

export function decryptSecret(stored: string, purpose: SecretPurpose): string {
  const parts = stored.split(".");
  if (parts.length !== 5) throw new SecretUnreadableError("malformed ciphertext envelope");
  const [version, storedPurpose, ivPart, tagPart, dataPart] = parts as [
    string, string, string, string, string,
  ];
  if (version !== "v1") throw new SecretUnreadableError(`unknown envelope version ${version}`);
  // Checked, not assumed: a ciphertext written for one purpose must not be
  // readable under another's key even if the caller passes the wrong one.
  if (storedPurpose !== purpose) {
    throw new SecretUnreadableError(`ciphertext is for ${storedPurpose}, not ${purpose}`);
  }

  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(purpose), Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    // GCM authentication failure, a wrong key, or truncated base64. All of
    // them mean the same thing to a caller and none of them should leak the
    // underlying message, which can quote bytes.
    throw new SecretUnreadableError(
      `decryption failed: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }
}

/** True when a column value looks like something this module wrote. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith("v1.") && value.split(".").length === 5;
}
