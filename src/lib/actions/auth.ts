"use server";

import bcrypt from "bcryptjs";
import { headers } from "next/headers";
import { z } from "zod";

import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { PASSWORD_HASH_COST, PASSWORD_MIN_LENGTH } from "@/lib/auth/password";
import { log } from "@/lib/logger";
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

const signUpSchema = z.object({
  name: zShortText.min(1, "What should we call you?"),
  email: zEmail,
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
    // bcrypt silently truncates beyond 72 bytes, so a longer value is a lie
    // about strength rather than extra security.
    .max(72, "Passwords are limited to 72 characters"),
});

export type SignUpResult = { ok: true } | { ok: false; error: string; field?: string };

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
