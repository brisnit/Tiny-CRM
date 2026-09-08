import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { db } from "../helpers/fixtures";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const unique = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * The account-security flows have to be *reachable*.
 *
 * `requestPasswordReset`, `resetPassword` and `verifyEmail` were all implemented,
 * tested and correct — and none of them could be reached by a user. There was no
 * "Forgot password?" link, no /reset-password page, no /verify-email page, and
 * sign-up issued no verification token and sent no mail at all. The mechanism
 * existed; nothing was wired to it.
 *
 * That is a gap a unit test cannot see, because every unit passed. These tests
 * assert the wiring: that the entry points exist, that sign-up actually starts
 * verification, and that the reset link the email carries points at a route that
 * is really served.
 *
 * They deliberately do not re-test token expiry, single use, session revocation
 * or anti-enumeration — tests/security/account-lifecycle.test.ts owns those, and
 * duplicating them here would make it unclear which file is authoritative.
 */

describe("account-security entry points exist", () => {
  after(async () => {
    await db.$disconnect();
  });

  test("every route the emails link to is actually served", () => {
    for (const [label, page] of [
      ["password reset completion", "src/app/(auth)/reset-password/page.tsx"],
      ["password reset request", "src/app/(auth)/forgot-password/page.tsx"],
      ["email verification", "src/app/(auth)/verify-email/page.tsx"],
    ] as const) {
      assert.ok(existsSync(resolve(ROOT, page)), `${label} has no page at ${page}`);
    }
  });

  test("the reset email's link matches the route that serves it", () => {
    // A mismatch here sends every user of the reset flow to a 404, and no unit
    // test would notice because both halves are individually correct.
    const auth = read("src/lib/actions/auth.ts");
    // Anchored on the reset function's own body: the verification link uses the
    // same template shape a few lines above, so an unanchored match finds that
    // one instead and the assertion silently tests the wrong thing.
    const resetBody = auth.slice(auth.indexOf("export async function requestPasswordReset"));
    // Deliberately agnostic about how the origin is produced — that moved to
    // appOrigin() when reset links were found going out on a deployment
    // hostname. What this test is for is that the link and the route agree.
    const path = /\$\{[^}]+\}(\/[a-z-]+)\?token=/.exec(resetBody)?.[1];
    assert.equal(path, "/reset-password", `the reset email links to ${path}`);
    assert.ok(existsSync(resolve(ROOT, `src/app/(auth)${path}/page.tsx`)));
  });

  test("the verification email's link matches the route that serves it", () => {
    const auth = read("src/lib/actions/auth.ts");
    const sendBody = auth.slice(auth.indexOf("async function sendVerificationEmail"));
    const path = /\$\{[^}]+\}(\/[a-z-]+)\?token=/.exec(sendBody)?.[1];
    assert.equal(path, "/verify-email", `the verification email links to ${path}`);
    assert.ok(existsSync(resolve(ROOT, "src/app/(auth)/verify-email/page.tsx")));
  });

  test("the login form offers a way to reach password reset", () => {
    const forms = read("src/components/app/auth-forms.tsx");
    assert.match(forms, /forgot-password/, "the sign-in form has no link to password reset");
  });

  test("sign-up issues a verification token and sends the email", async () => {
    const email = `${unique("verify-wiring")}@test.local`;
    const { signUp } = await import("../../src/lib/actions/auth");

    const result = await signUp({
      name: "Wiring Probe",
      email,
      password: "a-perfectly-good-password",
    } as never);
    assert.equal(result.ok, true, `sign-up failed: ${JSON.stringify(result)}`);

    const user = await db.user.findUnique({ where: { email }, select: { id: true, emailVerifiedAt: true } });
    assert.ok(user, "no account was created");
    assert.equal(user!.emailVerifiedAt, null, "sign-up must not mark an address verified by itself");

    const tokens = await db.authToken.findMany({
      where: { userId: user!.id, purpose: "email_verification" },
      select: { id: true, usedAt: true, expiresAt: true },
    });
    assert.equal(tokens.length, 1, "sign-up did not issue exactly one verification token");
    assert.equal(tokens[0]!.usedAt, null, "the token was already marked used");
    assert.ok(tokens[0]!.expiresAt.getTime() > Date.now(), "the token was issued already expired");

    await db.authToken.deleteMany({ where: { userId: user!.id } });
    await db.user.delete({ where: { id: user!.id } });
  });

  test("a failure to send mail does not fail the sign-up", async () => {
    // The account exists either way; a verification email that could not be sent
    // is a resend, not a lost registration. Asserted because the alternative —
    // rolling the sign-up back on a provider outage — is a tempting mistake.
    const auth = read("src/lib/actions/auth.ts");
    const signUpBody = auth.slice(auth.indexOf("export async function signUp"), auth.indexOf("// ----", auth.indexOf("export async function signUp")));
    assert.match(
      signUpBody,
      /sendMail|sendVerificationEmail/,
      "sign-up does not send a verification email",
    );
    assert.doesNotMatch(
      signUpBody,
      /throw[^;]*mail/i,
      "sign-up appears to throw when mail fails, which would lose the account",
    );
  });
});
