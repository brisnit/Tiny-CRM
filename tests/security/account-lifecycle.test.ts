import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import bcrypt from "bcryptjs";

import { runAsTestIdentity } from "../../src/lib/auth/context";
import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

/**
 * The account lifecycle, attacked.
 *
 * Password reset, email verification, session revocation and second factors are
 * the controls an attacker meets first, and each has a well-known way to get it
 * wrong. These tests are written as the attempts rather than as the features:
 * enumerate through timing, replay a consumed token, keep a session alive across
 * a password reset, use a code twice, downgrade a role and keep the old session.
 */

let A: Tenant;

describe("account lifecycle", () => {
  before(async () => {
    A = await createTenant("Lifecycle");
  });
  after(async () => {
    await cleanupTenants([A]);
    await db.$disconnect();
  });

  // -------------------------------------------------------------------------
  describe("password reset: enumeration", () => {
    test("an unknown address gets the same answer as a known one", async () => {
      const { requestPasswordReset } = await import("../../src/lib/actions/auth");
      const { resetRateLimit } = await import("../../src/lib/rate-limit");

      const known = (await db.user.findUniqueOrThrow({ where: { id: A.ownerId } })).email;
      const unknown = `nobody-${Date.now()}@example.invalid`;

      await resetRateLimit("passwordReset", { ip: "unknown", account: known });
      const first = await requestPasswordReset({ email: known });
      await resetRateLimit("passwordReset", { ip: "unknown", account: unknown });
      const second = await requestPasswordReset({ email: unknown });

      assert.deepEqual(second, first, "the response revealed whether the account exists");
    });

    test("a malformed address gets the same answer too", async () => {
      const { requestPasswordReset } = await import("../../src/lib/actions/auth");
      // A validation error here would separate "not an email" from "no such
      // account", which narrows an attacker's list for free.
      const result = await requestPasswordReset({ email: "not-an-address" });
      assert.deepEqual(result, { ok: true });
    });

    test("a deactivated account issues no token but answers identically", async () => {
      const { requestPasswordReset } = await import("../../src/lib/actions/auth");
      const { resetRateLimit } = await import("../../src/lib/rate-limit");

      const user = await db.user.findUniqueOrThrow({ where: { id: A.viewerId } });
      await db.user.update({ where: { id: user.id }, data: { deactivatedAt: new Date() } });
      await resetRateLimit("passwordReset", { ip: "unknown", account: user.email });

      const result = await requestPasswordReset({ email: user.email });
      assert.deepEqual(result, { ok: true });

      const tokens = await db.authToken.count({
        where: { userId: user.id, purpose: "password_reset", usedAt: null },
      });
      assert.equal(tokens, 0, "a reset token was issued for a disabled account");

      await db.user.update({ where: { id: user.id }, data: { deactivatedAt: null } });
    });

    test("a throttled request still reports success", async () => {
      const { requestPasswordReset } = await import("../../src/lib/actions/auth");
      const user = await db.user.findUniqueOrThrow({ where: { id: A.memberId } });

      // Exhaust the per-account limit and keep going.
      for (let i = 0; i < 8; i++) {
        const result = await requestPasswordReset({ email: user.email });
        assert.deepEqual(result, { ok: true }, "throttling became observable in the response");
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("password reset: tokens", () => {
    /** Issues a reset token and returns the plaintext, as the email would carry it. */
    async function issueReset(userId: string): Promise<string> {
      const { issueToken } = await import("../../src/lib/auth/tokens");
      const { token } = await issueToken(userId, "password_reset");
      return token;
    }

    test("only the hash is stored, never the token", async () => {
      const token = await issueReset(A.ownerId);
      const rows = await db.authToken.findMany({
        where: { userId: A.ownerId, purpose: "password_reset" },
        select: { tokenHash: true },
      });
      assert.ok(rows.length > 0);
      assert.ok(
        !rows.some((r) => r.tokenHash === token || r.tokenHash.includes(token.slice(0, 16))),
        "the plaintext token is recoverable from the database",
      );
    });

    test("a token works once and never again", async () => {
      const { resetPassword } = await import("../../src/lib/actions/auth");
      const token = await issueReset(A.ownerId);

      const first = await resetPassword({ token, password: "a-brand-new-password" });
      assert.equal(first.ok, true, "a valid reset was refused");

      const second = await resetPassword({ token, password: "another-new-password" });
      assert.equal(second.ok, false, "a consumed token was accepted a second time");
    });

    test("requesting a new link kills the previous one", async () => {
      const { resetPassword } = await import("../../src/lib/actions/auth");
      const older = await issueReset(A.ownerId);
      await issueReset(A.ownerId); // supersedes it

      const result = await resetPassword({ token: older, password: "yet-another-password" });
      assert.equal(result.ok, false, "an older reset link still worked");
    });

    test("an expired token is refused", async () => {
      const { resetPassword } = await import("../../src/lib/actions/auth");
      const token = await issueReset(A.ownerId);
      const hash = (await import("../../src/lib/auth/tokens")).hashToken(token);

      await db.authToken.update({
        where: { tokenHash: hash },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const result = await resetPassword({ token, password: "an-expired-attempt-here" });
      assert.equal(result.ok, false, "an expired token was accepted");
    });

    test("a verification token cannot be used to reset a password", async () => {
      // Purpose confusion: two token types in one table, distinguished only by
      // a column. Getting this wrong turns "confirm your email" into "take over
      // the account".
      const { issueToken } = await import("../../src/lib/auth/tokens");
      const { resetPassword } = await import("../../src/lib/actions/auth");

      const { token } = await issueToken(A.ownerId, "email_verification");
      const result = await resetPassword({ token, password: "purpose-confusion-probe" });
      assert.equal(result.ok, false, "a verification token reset a password");
    });

    test("every failure gives the same message", async () => {
      const { resetPassword } = await import("../../src/lib/actions/auth");
      const messages = new Set<string>();

      for (const token of ["x".repeat(43), "y".repeat(43), "z".repeat(60)]) {
        const result = await resetPassword({ token, password: "some-valid-password" });
        assert.equal(result.ok, false);
        if (!result.ok) messages.add(result.error);
      }
      assert.equal(messages.size, 1, "failure messages distinguished the reason");
    });

    test("a weak password is refused before the token is consumed", async () => {
      const { resetPassword } = await import("../../src/lib/actions/auth");
      const token = await issueReset(A.ownerId);

      const weak = await resetPassword({ token, password: "short" });
      assert.equal(weak.ok, false);

      // The token must survive: burning it on a rejected password would strand
      // the user with a dead link and no way forward.
      const good = await resetPassword({ token, password: "a-perfectly-good-password" });
      assert.equal(good.ok, true, "a rejected password consumed the token");
    });
  });

  // -------------------------------------------------------------------------
  describe("password reset: session invalidation", () => {
    test("a reset revokes every session and bumps the epoch", async () => {
      const { createSession, validateSession } = await import("../../src/lib/auth/sessions");
      const { issueToken } = await import("../../src/lib/auth/tokens");
      const { resetPassword } = await import("../../src/lib/actions/auth");

      // Two sessions, as if from two devices.
      const laptop = await createSession(A.memberId, { userAgent: "Mozilla/5.0 Chrome/120" });
      const phone = await createSession(A.memberId, { userAgent: "Mozilla/5.0 iPhone Safari" });

      assert.equal(
        (await validateSession(A.memberId, laptop.sessionId, laptop.epoch)).valid,
        true,
        "a fresh session was not valid",
      );

      const { token } = await issueToken(A.memberId, "password_reset");
      const result = await resetPassword({ token, password: "reset-invalidates-sessions" });
      assert.equal(result.ok, true);

      for (const [label, session] of [["laptop", laptop], ["phone", phone]] as const) {
        const check = await validateSession(A.memberId, session.sessionId, session.epoch);
        assert.equal(check.valid, false, `the ${label} session survived a password reset`);
      }
    });

    test("a session token from before the reset cannot resolve an identity", async () => {
      // The end-to-end version: not just "the row says revoked", but "the
      // application refuses to act as this user".
      const { createSession } = await import("../../src/lib/auth/sessions");
      const { issueToken } = await import("../../src/lib/auth/tokens");
      const { resetPassword } = await import("../../src/lib/actions/auth");
      const { validateSession } = await import("../../src/lib/auth/sessions");

      const session = await createSession(A.viewerId, { userAgent: "probe" });
      const { token } = await issueToken(A.viewerId, "password_reset");
      await resetPassword({ token, password: "replay-after-reset-probe" });

      const check = await validateSession(A.viewerId, session.sessionId, session.epoch);
      assert.equal(check.valid, false);
      assert.equal(check.reason, "stale_epoch", "the epoch did not advance on reset");
    });

    test("a reset clears a lockout rather than stranding the owner", async () => {
      const { issueToken } = await import("../../src/lib/auth/tokens");
      const { resetPassword } = await import("../../src/lib/actions/auth");

      await db.user.update({
        where: { id: A.viewerId },
        data: { failedLoginCount: 8, lockedUntil: new Date(Date.now() + 900_000) },
      });

      const { token } = await issueToken(A.viewerId, "password_reset");
      await resetPassword({ token, password: "unlock-through-reset-abc" });

      const user = await db.user.findUniqueOrThrow({ where: { id: A.viewerId } });
      assert.equal(user.lockedUntil, null, "the account stayed locked after a valid reset");
      assert.equal(user.failedLoginCount, 0);
    });

    test("the new password actually works and the old one does not", async () => {
      const { issueToken } = await import("../../src/lib/auth/tokens");
      const { resetPassword } = await import("../../src/lib/actions/auth");

      const { token } = await issueToken(A.memberId, "password_reset");
      await resetPassword({ token, password: "the-final-password-value" });

      const user = await db.user.findUniqueOrThrow({ where: { id: A.memberId } });
      assert.ok(user.passwordHash);
      assert.equal(await bcrypt.compare("the-final-password-value", user.passwordHash!), true);
      assert.equal(await bcrypt.compare("correct-horse-battery", user.passwordHash!), false);
      assert.ok(user.passwordChangedAt, "passwordChangedAt was not stamped");
    });
  });

  // -------------------------------------------------------------------------
  describe("email verification", () => {
    test("a token verifies once and cannot be replayed", async () => {
      const { issueToken } = await import("../../src/lib/auth/tokens");
      const { verifyEmail } = await import("../../src/lib/actions/auth");

      await db.user.update({ where: { id: A.unverifiedId }, data: { emailVerifiedAt: null } });
      const { token } = await issueToken(A.unverifiedId, "email_verification");

      const first = await verifyEmail(token);
      assert.equal(first.ok, true);

      const user = await db.user.findUniqueOrThrow({ where: { id: A.unverifiedId } });
      assert.ok(user.emailVerifiedAt, "the address was not marked verified");

      const second = await verifyEmail(token);
      assert.equal(second.ok, false, "a verification token was replayed");
    });

    test("a reset token cannot verify an address", async () => {
      const { issueToken } = await import("../../src/lib/auth/tokens");
      const { verifyEmail } = await import("../../src/lib/actions/auth");

      await db.user.update({ where: { id: A.unverifiedId }, data: { emailVerifiedAt: null } });
      const { token } = await issueToken(A.unverifiedId, "password_reset");

      const result = await verifyEmail(token);
      assert.equal(result.ok, false, "a reset token verified an email address");
    });

    test("an unverified account cannot export, invite or connect an integration", async () => {
      const { requireWorkspaceAccess } = await import("../../src/lib/auth/access");

      // The unverified fixture is an *admin*, so a refusal here is the
      // verification gate and not a role check.
      for (const capability of [
        "record:export", "import:run", "members:manage", "integrations:manage",
      ] as const) {
        await assert.rejects(
          runAsTestIdentity(A.unverifiedId, () =>
            requireWorkspaceAccess(A.workspaceId, capability),
          ),
          (error: { category?: string; meta?: { reason?: string } }) => {
            assert.equal(error.category, "forbidden");
            assert.equal(error.meta?.reason, "email_unverified", `${capability} refused for the wrong reason`);
            return true;
          },
          `an unverified account could ${capability}`,
        );
      }
    });

    test("an unverified account can still use its own workspace", async () => {
      // The gate must not be a wall. Someone who has just signed up needs to be
      // able to try the product, or verification becomes a churn mechanism.
      const { requireWorkspaceAccess } = await import("../../src/lib/auth/access");

      for (const capability of ["record:view", "record:create", "record:edit", "ai:use"] as const) {
        await assert.doesNotReject(
          runAsTestIdentity(A.unverifiedId, () =>
            requireWorkspaceAccess(A.workspaceId, capability),
          ),
          `an unverified account was blocked from ${capability}`,
        );
      }
    });

    test("verifying lifts the gate", async () => {
      const { requireWorkspaceAccess } = await import("../../src/lib/auth/access");
      await db.user.update({
        where: { id: A.unverifiedId },
        data: { emailVerifiedAt: new Date() },
      });

      await assert.doesNotReject(
        runAsTestIdentity(A.unverifiedId, () =>
          requireWorkspaceAccess(A.workspaceId, "record:export"),
        ),
      );

      await db.user.update({ where: { id: A.unverifiedId }, data: { emailVerifiedAt: null } });
    });
  });

  // -------------------------------------------------------------------------
  describe("sessions", () => {
    test("a revoked session stops working immediately", async () => {
      const { createSession, validateSession, revokeSession } =
        await import("../../src/lib/auth/sessions");

      const session = await createSession(A.ownerId, { userAgent: "Mozilla/5.0 Chrome/120" });
      const before = await validateSession(A.ownerId, session.sessionId, session.epoch);
      assert.equal(before.valid, true);

      const revoked = await revokeSession(A.ownerId, before.valid ? before.sessionId : "", "signed_out");
      assert.equal(revoked, true);

      const after = await validateSession(A.ownerId, session.sessionId, session.epoch);
      assert.equal(after.valid, false, "a revoked session still validated");
      assert.equal(after.reason, "revoked");
    });

    test("one user cannot revoke another user's session", async () => {
      const { createSession, revokeSession, validateSession } =
        await import("../../src/lib/auth/sessions");

      const victim = await createSession(A.ownerId, { userAgent: "victim" });
      const check = await validateSession(A.ownerId, victim.sessionId, victim.epoch);
      assert.equal(check.valid, true);

      const stolen = await revokeSession(A.memberId, check.valid ? check.sessionId : "", "signed_out");
      assert.equal(stolen, false, "a session was revoked by someone who does not own it");

      const still = await validateSession(A.ownerId, victim.sessionId, victim.epoch);
      assert.equal(still.valid, true, "the victim's session was revoked anyway");
    });

    test("sign out everywhere kills every session at once", async () => {
      const { createSession, validateSession, revokeAllSessions } =
        await import("../../src/lib/auth/sessions");

      const sessions = await Promise.all([
        createSession(A.ownerId, { userAgent: "one" }),
        createSession(A.ownerId, { userAgent: "two" }),
        createSession(A.ownerId, { userAgent: "three" }),
      ]);

      await revokeAllSessions(A.ownerId, "signed_out_others");

      for (const session of sessions) {
        const check = await validateSession(A.ownerId, session.sessionId, session.epoch);
        assert.equal(check.valid, false, "a session survived sign-out-everywhere");
      }
    });

    test("a token with no session id is refused", async () => {
      // Tokens minted before server-side sessions existed. Grandfathering them
      // would leave exactly the unrevocable sessions this work removes.
      const { validateSession } = await import("../../src/lib/auth/sessions");
      const user = await db.user.findUniqueOrThrow({ where: { id: A.ownerId } });
      const check = await validateSession(A.ownerId, null, user.sessionEpoch);
      assert.equal(check.valid, false);
    });

    test("a forged session id matches nothing", async () => {
      const { validateSession } = await import("../../src/lib/auth/sessions");
      const user = await db.user.findUniqueOrThrow({ where: { id: A.ownerId } });
      const check = await validateSession(A.ownerId, "forged-session-identifier", user.sessionEpoch);
      assert.equal(check.valid, false);
      assert.equal(check.reason, "unknown");
    });

    test("only the hash of a session id is stored", async () => {
      const { createSession } = await import("../../src/lib/auth/sessions");
      const session = await createSession(A.ownerId, { userAgent: "hash probe" });

      const rows = await db.userSession.findMany({
        where: { userId: A.ownerId },
        select: { tokenHash: true },
      });
      assert.ok(
        !rows.some((r) => r.tokenHash === session.sessionId),
        "a usable session id is stored in the database",
      );
    });

    test("addresses are truncated before storage", async () => {
      const { truncateIp } = await import("../../src/lib/auth/sessions");
      assert.equal(truncateIp("203.0.113.42"), "203.0.113.0/24");
      assert.equal(truncateIp("2001:db8:85a3:8d3:1319:8a2e:370:7348"), "2001:db8:85a3::/48");
      assert.equal(truncateIp("unknown"), null);
      assert.equal(truncateIp(null), null);
    });

    test("an expired session is refused even if never revoked", async () => {
      const { createSession, validateSession, hashSessionId } =
        await import("../../src/lib/auth/sessions");

      const session = await createSession(A.ownerId, { userAgent: "expiry probe" });
      await db.userSession.update({
        where: { tokenHash: hashSessionId(session.sessionId) },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const check = await validateSession(A.ownerId, session.sessionId, session.epoch);
      assert.equal(check.valid, false);
      assert.equal(check.reason, "expired");
    });
  });

  // -------------------------------------------------------------------------
  describe("two-factor authentication", () => {
    test("a secret is encrypted at rest and round-trips", async () => {
      const { encryptSecret, decryptSecret, generateSecret } =
        await import("../../src/lib/auth/mfa");

      const secret = generateSecret();
      const stored = encryptSecret(secret);

      assert.ok(!stored.includes(secret), "the secret is stored in the clear");
      assert.equal(decryptSecret(stored), secret);
    });

    test("a tampered ciphertext fails rather than yielding a wrong secret", async () => {
      const { encryptSecret, decryptSecret, generateSecret } =
        await import("../../src/lib/auth/mfa");

      const stored = encryptSecret(generateSecret());
      const parts = stored.split(".");
      const tampered = [parts[0], parts[1], parts[2], `${parts[3]!.slice(0, -2)}AA`].join(".");

      assert.throws(() => decryptSecret(tampered), "a tampered secret decrypted anyway");
    });

    test("a valid code is accepted and an invalid one is not", async () => {
      const { generateSecret, codeForStep, currentStep, verifyCode } =
        await import("../../src/lib/auth/mfa");

      const secret = generateSecret();
      const valid = codeForStep(secret, currentStep());

      assert.equal(verifyCode(secret, valid).ok, true);
      assert.equal(verifyCode(secret, "000000").ok, false);
      assert.equal(verifyCode(secret, "12345").ok, false, "a five-digit code was accepted");
      assert.equal(verifyCode(secret, "abcdef").ok, false);
    });

    test("one step of clock drift is tolerated, two is not", async () => {
      const { generateSecret, codeForStep, currentStep, verifyCode } =
        await import("../../src/lib/auth/mfa");

      const secret = generateSecret();
      const now = currentStep();

      assert.equal(verifyCode(secret, codeForStep(secret, now - 1)).ok, true, "no drift tolerance");
      assert.equal(verifyCode(secret, codeForStep(secret, now + 1)).ok, true);
      assert.equal(
        verifyCode(secret, codeForStep(secret, now - 3)).ok,
        false,
        "the acceptance window is far too wide",
      );
    });

    test("a code cannot be replayed inside its own window", async () => {
      // Without this, a code seen over someone's shoulder or captured by a
      // phishing proxy stays valid for the rest of its thirty seconds.
      const { generateSecret, codeForStep, currentStep, verifyCode } =
        await import("../../src/lib/auth/mfa");

      const secret = generateSecret();
      const step = currentStep();
      const code = codeForStep(secret, step);

      assert.equal(verifyCode(secret, code, { lastUsedStep: null }).ok, true);
      const replay = verifyCode(secret, code, { lastUsedStep: step });
      assert.equal(replay.ok, false, "a used code was accepted again");
      if (!replay.ok) assert.equal(replay.reason, "replayed");
    });

    test("recovery codes are hashed, single-use, and replaced on regeneration", async () => {
      const { generateRecoveryCodes, consumeRecoveryCode, remainingRecoveryCodes } =
        await import("../../src/lib/auth/mfa");

      const codes = await generateRecoveryCodes(A.ownerId);
      assert.equal(codes.length, 10);

      const stored = await db.mfaRecoveryCode.findMany({
        where: { userId: A.ownerId },
        select: { codeHash: true },
      });
      assert.ok(
        !stored.some((row) => codes.includes(row.codeHash)),
        "recovery codes are stored in the clear",
      );

      assert.equal(await consumeRecoveryCode(A.ownerId, codes[0]!), true);
      assert.equal(
        await consumeRecoveryCode(A.ownerId, codes[0]!),
        false,
        "a recovery code was used twice",
      );
      assert.equal(await remainingRecoveryCodes(A.ownerId), 9);

      const replacement = await generateRecoveryCodes(A.ownerId);
      assert.equal(
        await consumeRecoveryCode(A.ownerId, codes[1]!),
        false,
        "an old recovery code survived regeneration",
      );
      assert.equal(await consumeRecoveryCode(A.ownerId, replacement[0]!), true);
    });

    test("MFA reports honestly that it is not yet enforced at sign-in", async () => {
      // The capability is enrolment-only. A status that claimed otherwise would
      // leave a user believing they are protected when they are not, which is
      // more dangerous than knowing they are not.
      const { MFA_ENFORCED_AT_SIGN_IN, requireMfaChallenge, mfaStatus } =
        await import("../../src/lib/auth/mfa");

      assert.equal(typeof MFA_ENFORCED_AT_SIGN_IN, "boolean");
      const status = await mfaStatus(A.ownerId);
      assert.equal(
        status.enforcedAtSignIn,
        MFA_ENFORCED_AT_SIGN_IN,
        "the status shown to a user disagrees with what sign-in does",
      );

      if (!MFA_ENFORCED_AT_SIGN_IN) {
        assert.equal(
          await requireMfaChallenge(A.ownerId),
          false,
          "sign-in would demand a code that it cannot actually collect",
        );
      }
    });
  });
});
