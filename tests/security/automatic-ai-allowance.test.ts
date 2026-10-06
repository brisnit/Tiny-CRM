import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createTenant, cleanupTenants, db as observer, type Tenant } from "../helpers/fixtures";
import {
  AUTOMATIC_ALLOWANCE_SHARE,
  reserveAiOrThrow,
  reserveAutomaticAi,
} from "../../src/lib/entitlements";
import { PLANS, aiAllowanceFor } from "../../src/lib/plans";
import { currentPeriod } from "../../src/lib/dates";
import { requireActor } from "../../src/lib/auth/access";
import { runAsTestIdentity } from "../../src/lib/auth/context";

/**
 * Half of a month's allowance is always the customer's to spend.
 *
 * ## The measurement this exists for
 *
 * A brand-new Free account on production read **4 of its allowance before its
 * owner typed anything** — the daily brief on the home page, plus a record
 * summary for each record opened — and 7 after one real question. On Free's
 * standing allowance of 10 (October's grandfathered 25 is currently hiding
 * this), a customer could spend most of the month looking around, and the first
 * question they actually cared about would be refused by work they never asked
 * for.
 *
 * ## What is asserted
 *
 * Automatic requests stop at their share. A user's own request keeps the whole
 * allowance. And the reservation is one atomic counter rather than two, so the
 * two kinds cannot race each other into overspending — which is why these tests
 * read the counter rather than trusting return values alone.
 */

let tenant: Tenant;
const period = currentPeriod();

/** The allowance as the code under test computes it, not as retyped here. */
function allowanceFor(planId: "free" | "plus" | "pro"): number {
  return aiAllowanceFor(PLANS[planId], period);
}

async function actorFor(t: Tenant) {
  return runAsTestIdentity(t.ownerId, () => requireActor());
}

async function usage(userId: string): Promise<number> {
  const row = await observer.usageCounter.findFirst({
    where: { userId, metric: "ai_requests", period },
    select: { count: true },
  });
  return row?.count ?? 0;
}

before(async () => {
  tenant = await createTenant("AutoAllowance", { plan: "free" });
});

after(async () => {
  await cleanupTenants([tenant]);
});

beforeEach(async () => {
  await observer.usageCounter.deleteMany({ where: { userId: tenant.ownerId } });
});

describe("the automatic share", () => {
  test("is a share, so it follows the allowance rather than being retyped", () => {
    assert.ok(
      AUTOMATIC_ALLOWANCE_SHARE > 0 && AUTOMATIC_ALLOWANCE_SHARE < 1,
      "the share must leave something for both kinds of request",
    );
  });

  test("automatic requests stop at the share, not at the allowance", async () => {
    const actor = await actorFor(tenant);
    const allowance = allowanceFor("free");
    const ceiling = Math.floor(allowance * AUTOMATIC_ALLOWANCE_SHARE);
    assert.ok(ceiling >= 1 && ceiling < allowance, `ceiling ${ceiling} of ${allowance} is not a useful fixture`);

    let granted = 0;
    // Ask for far more than the whole allowance, so a missing ceiling shows up
    // as the allowance rather than as the share.
    for (let i = 0; i < allowance + 5; i += 1) {
      if (await reserveAutomaticAi(actor)) granted += 1;
    }

    assert.equal(granted, ceiling, `automatic work took ${granted} of an allowance of ${allowance}`);
    assert.equal(await usage(tenant.ownerId), ceiling, "the counter disagrees with what was granted");
  });

  test("it refuses rather than throwing, because the caller degrades", async () => {
    const actor = await actorFor(tenant);
    const ceiling = Math.floor(allowanceFor("free") * AUTOMATIC_ALLOWANCE_SHARE);
    for (let i = 0; i < ceiling; i += 1) await reserveAutomaticAi(actor);

    // No rejection: a page render must not throw because a summary nobody asked
    // for cannot be written by a model.
    const result = await reserveAutomaticAi(actor);
    assert.equal(result, false, "the automatic reservation was granted past its share");
  });

  test("the customer's own request can still use the whole allowance", async () => {
    const actor = await actorFor(tenant);
    const allowance = allowanceFor("free");
    const ceiling = Math.floor(allowance * AUTOMATIC_ALLOWANCE_SHARE);

    // Spend the automatic share first, as a month of browsing would.
    for (let i = 0; i < allowance + 5; i += 1) await reserveAutomaticAi(actor);
    assert.equal(await usage(tenant.ownerId), ceiling);

    // Every remaining request must be available to the person.
    for (let i = ceiling; i < allowance; i += 1) {
      await reserveAiOrThrow(actor);
    }
    assert.equal(await usage(tenant.ownerId), allowance, "the user could not reach their own allowance");

    // And only then is it genuinely gone.
    await assert.rejects(
      () => reserveAiOrThrow(actor),
      /allowance|used all/i,
      "the allowance was not enforced once fully spent",
    );
  });

  test("both kinds increment one counter, so they cannot overspend together", async () => {
    const actor = await actorFor(tenant);
    const allowance = allowanceFor("free");

    await reserveAiOrThrow(actor);
    await reserveAutomaticAi(actor);
    assert.equal(await usage(tenant.ownerId), 2, "the two paths are counting separately");

    // Drive both to exhaustion interleaved; the total must never exceed the
    // allowance however the calls are ordered.
    for (let i = 0; i < allowance * 2; i += 1) {
      if (i % 2 === 0) await reserveAutomaticAi(actor);
      else await reserveAiOrThrow(actor).catch(() => {});
    }
    const total = await usage(tenant.ownerId);
    assert.ok(total <= allowance, `${total} requests were counted against an allowance of ${allowance}`);
  });

  test("concurrent automatic reservations do not exceed the share", async () => {
    const actor = await actorFor(tenant);
    const ceiling = Math.floor(allowanceFor("free") * AUTOMATIC_ALLOWANCE_SHARE);

    // The whole reason the ceiling is passed to the atomic reservation rather
    // than checked beforehand.
    const results = await Promise.all(
      Array.from({ length: ceiling + 6 }, () => reserveAutomaticAi(actor)),
    );
    const granted = results.filter(Boolean).length;
    assert.equal(granted, ceiling, `${granted} concurrent reservations were granted, ceiling is ${ceiling}`);
    assert.equal(await usage(tenant.ownerId), ceiling);
  });
});

describe("summaries fall back to the built-in engine rather than apologising", () => {
  test("the automatic path degrades to the offline provider in source", async () => {
    /**
     * Asserted at the call site. Driving it for real needs a page render with a
     * model-backed provider installed and the automatic share already spent;
     * the behaviour that matters is which branch is taken, and taking the wrong
     * one is the defect — an apology where a structured summary belongs.
     */
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/lib/ai/summaries.ts"), "utf8");

    const automatic = [...source.matchAll(/reserveAutomaticAi\(actor\)/g)].length;
    assert.equal(automatic, 2, "expected the automatic reservation on both the record summary and the brief");

    const fallbacks = [...source.matchAll(/provider = offlineProvider\(\)/g)].length;
    assert.equal(
      fallbacks,
      2,
      "a refused automatic reservation must produce the deterministic summary, " +
        "not the degrade() apology — that text is for a failure, and this is not one",
    );

    // The user-initiated path must keep the throwing reservation, so somebody
    // waiting on a regenerate still sees a real error with an upgrade prompt.
    assert.match(source, /if \(userAsked\(options\)\) \{\s*await reserveAiOrThrow\(actor\);/);
  });
});
