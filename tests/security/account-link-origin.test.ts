import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validatePublicOrigin, CANONICAL_PRODUCTION_ORIGIN } from "../../src/lib/origin";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/**
 * Account-recovery links must point at the canonical domain.
 *
 * Password-reset and verification links were built straight from `env.appUrl`,
 * and the only checks on that value were "is HTTPS" and "is not localhost". A
 * *.vercel.app deployment hostname passes both, so it went out in real
 * account-recovery email.
 *
 * That is an account-lifecycle failure. A link on a deployment hostname works
 * until that deployment is superseded; after that the person locked out of
 * their account clicks a 404 and cannot tell whether the fault is theirs, the
 * link's, or the product's.
 *
 * `appOrigin()` reads configuration, so the behavioural half of this is tested
 * through `validatePublicOrigin`, which is the decision it makes. The
 * structural half asserts no link builder goes back to raw configuration.
 */
describe("customer-facing links use the canonical origin", () => {
  test("a deployment hostname is refused", () => {
    for (const host of [
      "https://tiny-crm-abc123-britt-midgettes-projects.vercel.app",
      "https://tiny-crm.vercel.app",
      "https://vercel.app",
    ]) {
      const verdict = validatePublicOrigin(host);
      assert.equal(verdict.ok, false, `${host} was accepted as a canonical origin`);
    }
  });

  test("localhost is refused", () => {
    for (const host of ["http://localhost:3000", "https://localhost", "https://127.0.0.1", "https://0.0.0.0"]) {
      assert.equal(validatePublicOrigin(host).ok, false, `${host} was accepted`);
    }
  });

  test("plain HTTP is refused even on a real domain", () => {
    assert.equal(validatePublicOrigin("http://tinycrm.biz").ok, false);
  });

  test("a missing value is refused rather than defaulted silently", () => {
    assert.equal(validatePublicOrigin(undefined).ok, false);
    assert.equal(validatePublicOrigin("").ok, false);
  });

  test("the canonical origin is accepted and normalised", () => {
    const verdict = validatePublicOrigin("https://tinycrm.biz/");
    assert.equal(verdict.ok, true);
    // Trailing slash removed, or every link becomes tinycrm.biz//reset-password
    assert.equal(verdict.ok && verdict.origin, "https://tinycrm.biz");
  });

  test("a second legitimate domain would still be accepted", () => {
    // Shape, not equality: configuring a different real domain later must not
    // require a code change.
    const verdict = validatePublicOrigin("https://app.example.com");
    assert.equal(verdict.ok, true);
  });

  test("the canonical fallback is the production domain", () => {
    assert.equal(CANONICAL_PRODUCTION_ORIGIN, "https://tinycrm.biz");
    assert.match(CANONICAL_PRODUCTION_ORIGIN, /^https:\/\//);
    assert.doesNotMatch(CANONICAL_PRODUCTION_ORIGIN, /vercel\.app|localhost/);
  });

  test("every account-email link is built from the helper, not raw configuration", () => {
    // The fix has to hold for verification and re-verification too, not just
    // the reset template that was reported.
    for (const file of ["src/lib/actions/auth.ts", "src/lib/actions/account.ts"]) {
      const source = read(file);
      const links = [...source.matchAll(/`\$\{([^}]+)\}\/(reset-password|verify-email)\?token=/g)];
      assert.ok(links.length > 0, `${file} builds no account links — has the path moved?`);
      for (const [, expression] of links) {
        assert.equal(
          expression.trim(),
          "appOrigin()",
          `${file} builds an account link from ${expression} instead of appOrigin()`,
        );
      }
    }
  });

  test("VERCEL_URL is never used to build a customer-facing URL", () => {
    // It holds the per-deployment hostname — the exact value that must not
    // reach a customer.
    for (const file of ["src/lib/origin.ts", "src/lib/env.ts", "src/lib/actions/auth.ts", "src/lib/actions/account.ts"]) {
      const source = read(file);
      const uses = source.split("\n").filter((l) => /VERCEL_URL/.test(l) && !/^\s*(\*|\/\/)/.test(l));
      assert.equal(uses.length, 0, `${file} reads VERCEL_URL: ${uses.join(" | ")}`);
    }
  });

  test("the token is URL-encoded and never logged", () => {
    const source = read("src/lib/actions/auth.ts");
    assert.match(source, /encodeURIComponent\(token\)/, "the token is no longer URL-encoded");
    // The full link is written only by the development sink; production must
    // never print a reset link or a bare token.
    const mail = read("src/lib/mail.ts");
    assert.match(mail, /sink/, "the mail adapter no longer distinguishes the development sink");
    for (const line of source.split("\n")) {
      if (!/log\.(info|warn|error|debug)/.test(line)) continue;
      assert.doesNotMatch(line, /\btoken\b|\blink\b/, `a log line may carry the reset token: ${line.trim()}`);
    }
  });

  test("anti-enumeration wording is unchanged", () => {
    // requestPasswordReset must answer identically whether or not the address
    // exists. Asserted here because this change touched the same function.
    const source = read("src/lib/actions/auth.ts");
    const body = source.slice(source.indexOf("export async function requestPasswordReset"));
    assert.doesNotMatch(
      body.slice(0, body.indexOf("\n}\n")),
      /no account|not found|does not exist|unknown email/i,
      "the reset response now reveals whether an account exists",
    );
  });
});
