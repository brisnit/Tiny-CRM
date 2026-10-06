import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

import { db } from "../helpers/fixtures";

/**
 * Signup consent: enforced on the server, and recorded.
 *
 * The checkbox on the form carries `required`, which stops an ordinary submit.
 * That is a courtesy to the person filling the form, not a control — a client can
 * be made to post anything, so the only thing that actually enforces acceptance
 * is the server action. These tests exercise the action directly, with no form
 * involved, which is the shape an attacker would use.
 *
 * Mutation-checked: deleting the `acceptedTerms` field from `signUpSchema` makes
 * the first three tests pass vacuously, so each one asserts that **no account
 * row was created**, not merely that the call returned an error.
 */

const PASSWORD = "a-sufficiently-long-password";
const created: string[] = [];

function address(label: string): string {
  return `terms-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}

async function freshSignUp(input: Record<string, unknown>) {
  const { signUp } = await import("../../src/lib/actions/auth");
  const { resetRateLimit } = await import("../../src/lib/rate-limit");
  // The action rate-limits by IP, and these tests all arrive as "unknown".
  await resetRateLimit("signup", "unknown");
  return signUp(input as never);
}

describe("signup requires accepting the terms", () => {
  after(async () => {
    if (created.length > 0) {
      await db.user.deleteMany({ where: { email: { in: created } } });
    }
  });

  for (const [label, value] of [
    ["omitted", undefined],
    ["false", false],
    ["the string \"on\" rather than a boolean", "on"],
    ["null", null],
  ] as const) {
    test(`refuses a signup with acceptance ${label}, and creates nothing`, async () => {
      const email = address("refused");
      const result = await freshSignUp({
        name: "Refused",
        email,
        password: PASSWORD,
        ...(value === undefined ? {} : { acceptedTerms: value }),
      });

      assert.equal(result.ok, false, "the signup was accepted without consent");
      if (!result.ok) {
        assert.match(
          result.error,
          /accept the terms/i,
          "the refusal did not say what was wrong",
        );
      }

      // The assertion that makes this test load-bearing: no row.
      const row = await db.user.findUnique({ where: { email }, select: { id: true } });
      assert.equal(row, null, "an account was created despite consent being refused");
    });
  }

  test("accepts a signup with explicit consent, and records the version and time", async () => {
    const { TERMS_VERSION, LEGAL_EFFECTIVE_ON } = await import("../../src/lib/legal");
    const email = address("accepted");
    created.push(email);

    const before = Date.now();
    const result = await freshSignUp({
      name: "Accepted",
      email,
      password: PASSWORD,
      acceptedTerms: true,
    });
    const after_ = Date.now();

    assert.equal(result.ok, true, `signup failed: ${JSON.stringify(result)}`);

    const row = await db.user.findUnique({
      where: { email },
      select: { termsAcceptedVersion: true, termsAcceptedAt: true },
    });
    assert.ok(row, "no account was created");

    assert.equal(
      row!.termsAcceptedVersion,
      TERMS_VERSION,
      "the recorded version is not the one the pages publish",
    );
    assert.equal(
      TERMS_VERSION,
      LEGAL_EFFECTIVE_ON,
      "the recorded version and the published effective date have drifted apart",
    );

    assert.ok(row!.termsAcceptedAt, "no acceptance timestamp was recorded");
    const at = row!.termsAcceptedAt!.getTime();
    assert.ok(
      at >= before - 1000 && at <= after_ + 1000,
      `the acceptance timestamp ${new Date(at).toISOString()} is not when the signup happened`,
    );
  });

  test("the recorded version is a date the effective-date helper can render", async () => {
    // Guards the pairing the acceptance record depends on: a stored version that
    // no page could display would be unanswerable in a dispute.
    const { LEGAL_EFFECTIVE_ON, legalEffectiveDate } = await import("../../src/lib/legal");
    assert.match(LEGAL_EFFECTIVE_ON, /^\d{4}-\d{2}-\d{2}$/, "the version is not an ISO date");
    assert.match(
      legalEffectiveDate(),
      /^\d{1,2} [A-Z][a-z]+ \d{4}$/,
      "the effective date does not render as prose",
    );
    // Parsed as UTC, so a timezone behind UTC cannot print the previous day.
    const [, , day] = LEGAL_EFFECTIVE_ON.split("-");
    assert.ok(
      legalEffectiveDate().startsWith(String(Number(day))),
      `the rendered date ${legalEffectiveDate()} does not start with day ${Number(day)}`,
    );
  });
});
