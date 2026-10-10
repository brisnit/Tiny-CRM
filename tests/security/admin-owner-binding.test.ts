import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import {
  bindingRefusal,
  isOwnerAddress,
  OWNER_ADMIN_EMAIL,
} from "../../scripts/lib/owner-binding.mjs";
import {
  complimentaryBadgeLabel,
  complimentaryBadgeTitle,
  NO_EFFECT_LABEL,
} from "../../src/lib/admin/grant-label";

/**
 * The binding script's refusals, and the wording the panel uses for a grant
 * that is live but adding nothing.
 *
 * Both are things a human reads and acts on, which is exactly the kind of
 * correctness that no other test catches.
 */
describe("binding administration refuses any account but the owner's", () => {
  const owner = { id: "u_owner", email: OWNER_ADMIN_EMAIL, deactivatedAt: null };

  test("the owner's address is accepted, however it is cased or spaced", () => {
    assert.equal(OWNER_ADMIN_EMAIL, "hello@artifactdigital.co");
    for (const variant of [
      "hello@artifactdigital.co",
      "HELLO@ARTIFACTDIGITAL.CO",
      "Hello@ArtifactDigital.Co",
      "  hello@artifactdigital.co  ",
    ]) {
      assert.equal(isOwnerAddress(variant), true, `refused the owner as "${variant}"`);
    }
  });

  test("every near miss is refused, because a near miss is a different account", () => {
    for (const other of [
      "hello@artifactdigital.com",            // the wrong TLD
      "hello@artifactdigital.co.uk",
      "hello@artifactdigital.co.evil.test",   // suffix, not the domain
      "hello+admin@artifactdigital.co",       // plus-addressing is another row
      "hello@sub.artifactdigital.co",
      "ahello@artifactdigital.co",
      "hello@artifactdigital.c",
      "brisnit@gmail.com",
      "",
      null,
      undefined,
      12345,
    ]) {
      assert.equal(isOwnerAddress(other), false, `accepted "${String(other)}"`);
    }
  });

  test("a correctly typed id for the wrong account is refused by name", () => {
    // The failure the check exists for: the id resolves, so every other
    // verification in the script passes, and a real customer silently holds
    // the panel.
    const refusal = bindingRefusal({
      account: { id: "u_customer", email: "someone@example.com", deactivatedAt: null },
      existing: [],
    });
    assert.ok(refusal, "binding a customer's account was allowed");
    assert.match(refusal, /someone@example\.com/, "the refusal does not say which account it got");
    assert.match(refusal, /hello@artifactdigital\.co/, "the refusal does not say what it wanted");
  });

  test("the owner's own account is allowed, and nothing else about it is assumed", () => {
    assert.equal(bindingRefusal({ account: owner, existing: [] }), null);
  });

  test("an unknown id, a suspended owner and a second administrator are all refused", () => {
    assert.match(bindingRefusal({ account: null, existing: [] }) ?? "", /no account/i);
    assert.match(
      bindingRefusal({
        account: { ...owner, deactivatedAt: new Date() },
        existing: [],
      }) ?? "",
      /suspended/i,
    );
    assert.match(
      bindingRefusal({
        account: owner,
        existing: [{ userId: "u_someone_else", email: "old@artifactdigital.co" }],
      }) ?? "",
      /already bound/i,
    );
    // Re-binding the account that already holds it is not a second admin.
    assert.equal(
      bindingRefusal({ account: owner, existing: [{ userId: owner.id, email: owner.email }] }),
      null,
      "re-binding the existing administrator was refused",
    );
  });

  test("unbinding is never blocked by the rules that govern binding", () => {
    // Every one of those rules exists to stop administration being created in
    // the wrong place; each would otherwise block the recovery from that.
    for (const account of [
      { id: "u_x", email: "someone@example.com", deactivatedAt: null },
      { ...owner, deactivatedAt: new Date() },
    ]) {
      assert.equal(
        bindingRefusal({ unbind: true, account, existing: [{ userId: "u_y", email: "a@b.test" }] }),
        null,
        `unbinding was refused for ${account.email}`,
      );
    }
    assert.match(bindingRefusal({ unbind: true, account: null }) ?? "", /no account/i);
  });

  test("the script applies the rule rather than merely shipping it", () => {
    // A guard that is defined and never called reads like protection in
    // review. That has already happened once on this feature, so this asserts
    // the call site exists and that the old inline checks are gone.
    const source = readFileSync("scripts/bind-platform-admin.mjs", "utf8");
    assert.match(source, /from "\.\/lib\/owner-binding\.mjs"/, "the script does not import the rule");
    assert.match(source, /bindingRefusal\(\{\s*unbind,\s*account,\s*existing: before\s*\}\)/,
      "the script does not call bindingRefusal with the live values");
    assert.match(source, /process\.exit\(1\)/);
    // The INSERT must come after the refusal, not before it.
    assert.ok(
      source.indexOf("bindingRefusal(") < source.indexOf('INSERT INTO "PlatformAdmin"'),
      "the row is written before the refusal is evaluated",
    );
  });
});

describe("a live grant that adds nothing says so without calling itself inactive", () => {
  const expires = new Date("2026-12-01T00:00:00.000Z");

  test("the label names the effect, not the grant", () => {
    const label = complimentaryBadgeLabel({ plan: "plus", expiresAt: expires, inForce: false });
    assert.equal(NO_EFFECT_LABEL, "No additional access currently");
    assert.match(label, /No additional access currently/);
    // "Inactive" would say the grant is dead. It is live, it is stored, and it
    // resumes adding access the moment the account's own plan drops.
    assert.doesNotMatch(label, /inactive/i, 'the grant is described as "inactive"');
    assert.doesNotMatch(label, /expired|revoked|ended/i);
  });

  test("the expiry stays visible exactly when the grant adds nothing", () => {
    // The requirement this protects: an operator needs the date *in advance*,
    // and hiding it until it mattered would hide it while there was still time.
    const label = complimentaryBadgeLabel({ plan: "plus", expiresAt: expires, inForce: false });
    assert.match(label, /2026-12-01/, "the expiry disappeared for an inert grant");
    assert.match(label, /Complimentary: Plus/);

    const noExpiry = complimentaryBadgeLabel({ plan: "pro", expiresAt: null, inForce: false });
    assert.match(noExpiry, /no expiry/i);
    assert.match(noExpiry, /No additional access currently/);
  });

  test("a grant that is adding access says only that", () => {
    const label = complimentaryBadgeLabel({ plan: "pro", expiresAt: expires, inForce: true });
    assert.match(label, /^Complimentary: Pro · to 2026-12-01$/);
    assert.doesNotMatch(label, /No additional access/);
  });

  test("the tooltip explains why, and still promises the expiry", () => {
    const title = complimentaryBadgeTitle(
      { plan: "plus", expiresAt: expires, inForce: false },
      "design partner for Q1",
    );
    assert.match(title, /design partner for Q1/);
    assert.match(title, /No Stripe subscription, no charge/);
    assert.match(title, /No additional access currently/);
    assert.match(title, /still live and still expires/i);
    assert.doesNotMatch(title, /inactive/i);
  });
});
