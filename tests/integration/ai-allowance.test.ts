import { test, describe, after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { currentPeriod } from "../../src/lib/dates";
import { releaseAiRequest, reserveAiRequest } from "../../src/lib/entitlements";
import { UNLIMITED } from "../../src/lib/plans";
import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

/**
 * The metered AI allowance is a spending limit, so the only interesting question
 * about it is whether it holds under concurrency.
 *
 * The shape it replaced — `assertWithinLimit` to read the count, then
 * `recordUsage` to increment it — is a read, a decision and a write with gaps
 * between them. Two requests arriving together both read 29 against a limit of
 * 30, both decide they are within it, and both call a paid API. That is not a
 * rounding error in a usage display; it is the difference between a bounded bill
 * and an unbounded one, and the gap widens with concurrency, which is exactly
 * when someone is firing several questions at once.
 *
 * These tests run the real `reserveAiRequest` against the real database. The
 * concurrency case is the one that matters: it fires more requests than the
 * allowance permits, all at once, and asserts that the number of successful
 * claims equals the allowance exactly — never more.
 */

let A: Tenant;

async function usageFor(userId: string): Promise<number> {
  const row = await db.usageCounter.findUnique({
    where: { userId_metric_period: { userId, metric: "ai_requests", period: currentPeriod() } },
    select: { count: true },
  });
  return row?.count ?? 0;
}

async function resetUsage(userId: string): Promise<void> {
  await db.usageCounter.deleteMany({ where: { userId, metric: "ai_requests" } });
}

describe("metered AI allowance", () => {
  before(async () => {
    A = await createTenant("Allowance");
  });

  after(async () => {
    await cleanupTenants([A]);
    await db.$disconnect();
  });

  beforeEach(async () => {
    await resetUsage(A.ownerId);
  });

  test("claims succeed up to the limit and are refused after it", async () => {
    const limit = 3;
    const results: boolean[] = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(await reserveAiRequest(A.ownerId, limit));
    }

    assert.deepEqual(
      results,
      [true, true, true, false, false],
      "the first three claims are granted and the rest refused",
    );
    assert.equal(await usageFor(A.ownerId), limit, "the counter stops at the limit, it does not keep rising");
  });

  test("CONCURRENCY: simultaneous claims never exceed the allowance", async () => {
    const limit = 5;
    const attempts = 40;

    // All in flight together. With a read-then-write check this is where the
    // allowance leaks: every one of the 40 reads the same starting count.
    const granted = await Promise.all(
      Array.from({ length: attempts }, () => reserveAiRequest(A.ownerId, limit)),
    );

    const allowed = granted.filter(Boolean).length;
    assert.equal(
      allowed,
      limit,
      `exactly ${limit} of ${attempts} concurrent claims may be granted, got ${allowed}`,
    );
    assert.equal(
      await usageFor(A.ownerId),
      limit,
      "the stored counter agrees with the number of granted claims",
    );
  });

  test("a zero allowance grants nothing and writes nothing", async () => {
    assert.equal(await reserveAiRequest(A.ownerId, 0), false);
    assert.equal(await usageFor(A.ownerId), 0, "a refused claim must not create a counter row");
  });

  test("an unlimited allowance always grants, and still counts for reporting", async () => {
    assert.equal(await reserveAiRequest(A.ownerId, UNLIMITED), true);
    assert.equal(await reserveAiRequest(A.ownerId, UNLIMITED), true);
    assert.equal(await usageFor(A.ownerId), 2, "legacy unlimited plans are still measured");
  });

  test("release hands one claim back, and never goes below zero", async () => {
    await reserveAiRequest(A.ownerId, 5);
    await reserveAiRequest(A.ownerId, 5);
    assert.equal(await usageFor(A.ownerId), 2);

    await releaseAiRequest(A.ownerId);
    assert.equal(await usageFor(A.ownerId), 1, "a release decrements by one");

    await releaseAiRequest(A.ownerId);
    await releaseAiRequest(A.ownerId);
    assert.equal(await usageFor(A.ownerId), 0, "releases cannot drive the counter negative");
  });

  test("releasing makes room again, so a refused caller can proceed after one", async () => {
    const limit = 2;
    assert.equal(await reserveAiRequest(A.ownerId, limit), true);
    assert.equal(await reserveAiRequest(A.ownerId, limit), true);
    assert.equal(await reserveAiRequest(A.ownerId, limit), false, "allowance spent");

    await releaseAiRequest(A.ownerId);
    assert.equal(await reserveAiRequest(A.ownerId, limit), true, "the released claim is reusable");
  });

  test("allowances are per account: one account's usage does not touch another's", async () => {
    const B = await createTenant("AllowanceOther");
    try {
      await reserveAiRequest(A.ownerId, 1);
      assert.equal(await reserveAiRequest(A.ownerId, 1), false, "A is spent");
      assert.equal(await reserveAiRequest(B.ownerId, 1), true, "B is untouched by A");
    } finally {
      await resetUsage(B.ownerId);
      await cleanupTenants([B]);
    }
  });
});

describe("a spent allowance is a product outcome, not a server fault", () => {
  /**
   * The failure this pins is a 500.
   *
   * `failure()` in src/lib/actions/base.ts already recognised plan outcomes, so
   * server actions reported them correctly. Route handlers map errors through
   * `toAppError` instead, which did not — so an exhausted allowance on
   * /api/ai/chat returned 500 with a generic "something went wrong", hiding the
   * one thing the caller could act on. Same shape as the incident in
   * tests/integration/ai-enhancement-boundary.test.ts: fixed for server
   * components, missed for routes.
   */
  test("toAppError maps a spent allowance to 402 and keeps the message", async () => {
    const { toAppError } = await import("../../src/lib/errors");
    const { AiAllowanceError } = await import("../../src/lib/plans");

    const mapped = toAppError(new AiAllowanceError(30, "plus"));
    assert.equal(mapped.category, "ai_allowance");
    assert.equal(mapped.status, 402, "a spent allowance is Payment Required, not Internal Server Error");
    assert.match(mapped.message, /30/, "the limit survives, so the UI can say what ran out");
    assert.match(mapped.message, /built-in/i, "and that the built-in engine still works");
  });

  test("toAppError maps a plan limit to 402 and keeps the message", async () => {
    const { toAppError } = await import("../../src/lib/errors");
    const { PlanLimitError } = await import("../../src/lib/plans");

    const mapped = toAppError(new PlanLimitError("contacts", 100, "free"));
    assert.equal(mapped.category, "plan_limit");
    assert.equal(mapped.status, 402);
    assert.match(mapped.message, /contact/, "the noun survives so the message names what was reached");
  });

  test("an ordinary error is still internal, so this mapping cannot be used to leak one", async () => {
    const { toAppError } = await import("../../src/lib/errors");
    const mapped = toAppError(new Error("connection string postgres://user:pass@host/db failed"));
    assert.equal(mapped.category, "internal");
    assert.ok(
      !mapped.message.includes("postgres://"),
      "an internal error is still replaced with a generic message",
    );
  });
});
