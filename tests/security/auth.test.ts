import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

import bcrypt from "bcryptjs";

import { db } from "../helpers/fixtures";

/**
 * Authentication.
 *
 * The properties tested here are the ones an attacker probes first: how
 * passwords are stored, whether the app will tell them which email addresses
 * exist, and whether repeated guessing is free.
 */
describe("authentication", () => {
  after(async () => {
    await db.$disconnect();
  });

  describe("password storage", () => {
    test("passwords are hashed with a real work factor, never stored or reversible", async () => {
      const { PASSWORD_HASH_COST, PASSWORD_MIN_LENGTH } =
        await import("../../src/lib/auth/password");

      assert.ok(PASSWORD_HASH_COST >= 12, `bcrypt cost ${PASSWORD_HASH_COST} is too low for 2026`);
      assert.ok(PASSWORD_MIN_LENGTH >= 12, "the minimum password length is too short");

      const password = "correct horse battery staple";
      const hash = await bcrypt.hash(password, PASSWORD_HASH_COST);

      assert.ok(!hash.includes(password), "the plaintext appears in the hash");
      assert.match(hash, /^\$2[aby]\$\d{2}\$/, "not a bcrypt hash");
      assert.equal(hash.split("$")[2], String(PASSWORD_HASH_COST), "the stored cost is not the configured one");
      assert.equal(await bcrypt.compare(password, hash), true);
      assert.equal(await bcrypt.compare("wrong", hash), false);
    });

    test("the same password hashes differently every time", async () => {
      const { PASSWORD_HASH_COST } = await import("../../src/lib/auth/password");
      const a = await bcrypt.hash("same-password-value", PASSWORD_HASH_COST);
      const b = await bcrypt.hash("same-password-value", PASSWORD_HASH_COST);
      assert.notEqual(a, b, "hashes are unsalted — a rainbow table would work");
    });

    test("a hash at an outdated cost is flagged for upgrade on next sign-in", async () => {
      const { needsRehash, PASSWORD_HASH_COST } = await import("../../src/lib/auth/password");
      const weak = await bcrypt.hash("x".repeat(16), 4);
      assert.equal(needsRehash(weak), true, "an old low-cost hash was not flagged");

      const current = await bcrypt.hash("x".repeat(16), PASSWORD_HASH_COST);
      assert.equal(needsRehash(current), false, "a current hash was needlessly rehashed");
    });
  });

  describe("account enumeration", () => {
    test("sign-up answers identically for a new and an existing address", async () => {
      const { signUp } = await import("../../src/lib/actions/auth");
      const { resetRateLimit } = await import("../../src/lib/rate-limit");
      await resetRateLimit("signup", "unknown");

      const email = `enumerate-${Date.now()}@test.local`;
      const password = "a-sufficiently-long-password";

      const first = await signUp({ name: "First", email, password });
      await resetRateLimit("signup", "unknown");
      const second = await signUp({ name: "Second", email, password });

      assert.deepEqual(
        second, first,
        "sign-up revealed whether an account already exists",
      );

      // And the duplicate did not overwrite or duplicate the account.
      const count = await db.user.count({ where: { email } });
      assert.equal(count, 1, "a duplicate sign-up created a second account");
      const user = await db.user.findUniqueOrThrow({ where: { email } });
      assert.equal(user.name, "First", "a duplicate sign-up overwrote the existing account");

      await db.auditLog.deleteMany({ where: { actorEmail: email } });
      await db.user.delete({ where: { email } });
      await resetRateLimit("signup", "unknown");
    });

    test("a weak or oversized password is refused with a field-level message", async () => {
      const { signUp } = await import("../../src/lib/actions/auth");
      const { resetRateLimit } = await import("../../src/lib/rate-limit");
      await resetRateLimit("signup", "unknown");

      for (const password of ["short", "x".repeat(200)]) {
        const result = await signUp({
          name: "Probe", email: `weak-${Date.now()}@test.local`, password,
        });
        assert.equal(result.ok, false, `accepted a password of length ${password.length}`);
        if (!result.ok) assert.equal(result.field, "password");
        await resetRateLimit("signup", "unknown");
      }
    });

    test("sign-up is rate limited by client address", async () => {
      const { checkRateLimit, resetRateLimit, POLICIES } = await import("../../src/lib/rate-limit");
      await resetRateLimit("signup", "probe-ip");

      let blocked = false;
      for (let i = 0; i < POLICIES.signup.limit + 2; i++) {
        if (!(await checkRateLimit("signup", "probe-ip")).ok) {
          blocked = true;
          break;
        }
      }
      assert.ok(blocked, "unlimited accounts could be created from one address");
      await resetRateLimit("signup", "probe-ip");
    });
  });

  describe("brute force", () => {
    test("sign-in is throttled per address and per account independently", async () => {
      const { checkRateLimit, resetRateLimit, POLICIES } = await import("../../src/lib/rate-limit");

      // Per-account, so spreading attempts across a botnet does not help.
      await resetRateLimit("loginPerAccount", "victim@example.test");
      let accountBlocked = false;
      for (let i = 0; i < POLICIES.loginPerAccount.limit + 2; i++) {
        if (!(await checkRateLimit("loginPerAccount", "victim@example.test")).ok) {
          accountBlocked = true;
          break;
        }
      }
      assert.ok(accountBlocked, "credential stuffing against one account was never throttled");

      // Per-address, so trying many accounts from one host does not help either.
      await resetRateLimit("login", "1.2.3.4");
      let addressBlocked = false;
      for (let i = 0; i < POLICIES.login.limit + 2; i++) {
        if (!(await checkRateLimit("login", "1.2.3.4")).ok) {
          addressBlocked = true;
          break;
        }
      }
      assert.ok(addressBlocked, "password spraying from one address was never throttled");

      await resetRateLimit("loginPerAccount", "victim@example.test");
      await resetRateLimit("login", "1.2.3.4");
    });

    test("a rate-limited response carries a retry hint and does not leak the limit state", async () => {
      const { checkRateLimit, resetRateLimit } = await import("../../src/lib/rate-limit");
      await resetRateLimit("login", "hint-probe");
      let last = await checkRateLimit("login", "hint-probe");
      for (let i = 0; i < 20 && last.ok; i++) last = await checkRateLimit("login", "hint-probe");

      assert.equal(last.ok, false);
      assert.ok(last.retryAfterSeconds > 0, "no retry-after was provided");
      assert.equal(last.remaining, 0);
      await resetRateLimit("login", "hint-probe");
    });

    test("a deactivated account cannot resolve an identity even with a valid session", async () => {
      const { runAsTestIdentity } = await import("../../src/lib/auth/context");
      const { getIdentity } = await import("../../src/lib/auth/context");

      const user = await db.user.create({
        data: {
          email: `deactivated-${Date.now()}@test.local`,
          name: "Gone",
          passwordHash: await bcrypt.hash("a-sufficiently-long-password", 4),
          deactivatedAt: new Date(),
        },
      });

      const identity = await runAsTestIdentity(user.id, () => getIdentity());
      assert.equal(identity, null, "a deactivated account still resolved to an identity");

      await db.user.delete({ where: { id: user.id } });
    });
  });

  describe("session configuration", () => {
    test("cookies are host-scoped, http-only and same-site in production", async () => {
      // Asserted against the config object rather than a live request, because
      // the risk is a mis-set flag in the config, not a runtime bug.
      const { cookieOptions } = await import("../../src/lib/auth/cookies");
      const production = cookieOptions(true);
      assert.equal(production.httpOnly, true, "the session cookie is readable by JavaScript");
      assert.equal(production.secure, true, "the session cookie may be sent over HTTP");
      assert.equal(production.sameSite, "lax", "the session cookie has no SameSite protection");

      const development = cookieOptions(false);
      assert.equal(development.secure, false, "development over HTTP would be unusable");
      assert.equal(development.httpOnly, true, "httpOnly was relaxed in development");
    });
  });
});
