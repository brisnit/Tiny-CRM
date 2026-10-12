import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { contentSecurityPolicy, OAUTH_AUTHORIZE_ORIGINS } from "../../src/lib/csp";
import { PROVIDERS } from "../../src/lib/integrations/providers";

/**
 * The CSP's `form-action` list must cover every provider we can send someone to.
 *
 * ## The defect this exists for
 *
 * The Connect button is a form that POSTs to our own origin; the route answers
 * with a 303 to the provider's consent screen. `form-action` applies across
 * redirects, so with `'self'` alone the click did **nothing at all**: the
 * request never reached the server, so no log recorded it, and Chrome's console
 * message named the form's own same-origin action URL rather than the redirect
 * target — which pointed the investigation at the wrong thing entirely.
 *
 * ## Why this is a test and not a comment
 *
 * `src/lib/csp.ts` cannot import the provider table: that module is
 * `server-only` and reads `env`, while the CSP is built in the proxy's edge
 * runtime and in next.config.ts. So the list is written out by hand in two
 * places, which is exactly the shape that drifts. This compares them, so adding
 * a fifth connector without widening the policy fails here instead of shipping
 * a button that silently does nothing.
 */
describe("the CSP permits every OAuth authorisation origin, and nothing more", () => {
  const policy = contentSecurityPolicy("test-nonce");
  const formAction =
    policy
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("form-action")) ?? "";

  test("every provider's authorisation endpoint is covered", () => {
    assert.ok(formAction, "the policy has no form-action directive at all");
    for (const provider of Object.values(PROVIDERS)) {
      const origin = new URL(provider.authorizeUrl).origin;
      assert.ok(
        formAction.includes(origin),
        `form-action does not permit ${origin}, so Connect for ${provider.id} would do nothing`,
      );
    }
  });

  test("the hand-written list matches the providers exactly, with nothing spare", () => {
    // A stale entry is a quietly widened policy. Both directions are checked.
    const fromProviders = new Set(
      Object.values(PROVIDERS).map((p) => new URL(p.authorizeUrl).origin),
    );
    assert.deepEqual(
      new Set(OAUTH_AUTHORIZE_ORIGINS),
      fromProviders,
      "OAUTH_AUTHORIZE_ORIGINS and PROVIDERS disagree about which origins are needed",
    );
  });

  test("'self' is still there, and no wildcard was introduced", () => {
    assert.match(formAction, /'self'/, "same-origin form posts would be blocked");
    assert.doesNotMatch(formAction, /\*/, "a wildcard reached form-action");
    assert.doesNotMatch(formAction, /http:/, "a plaintext origin reached form-action");
  });

  test("the directive is origins only — no paths, which form-action ignores", () => {
    // A path here would look like a narrowing and achieve nothing, which is
    // worse than not writing one.
    for (const origin of OAUTH_AUTHORIZE_ORIGINS) {
      assert.equal(new URL(origin).pathname, "/", `${origin} carries a path`);
      assert.equal(origin, new URL(origin).origin, `${origin} is not a bare origin`);
    }
  });
});
