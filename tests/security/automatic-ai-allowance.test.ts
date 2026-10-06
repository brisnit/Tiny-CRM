import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createTenant, cleanupTenants, db as observer, type Tenant } from "../helpers/fixtures";
import { reserveAiOrThrow } from "../../src/lib/entitlements";
import { PLANS, aiAllowanceFor } from "../../src/lib/plans";
import { currentPeriod } from "../../src/lib/dates";
import { requireActor } from "../../src/lib/auth/access";
import { runAsTestIdentity } from "../../src/lib/auth/context";

/**
 * The monthly allowance is for what the customer asked for, and nothing else.
 *
 * ## The measurement this exists for
 *
 * A brand-new Free account on production read **4 of its allowance before its
 * owner typed anything** — the daily brief on the home page, plus a record
 * summary for each record opened — and 7 after one real question. On Free's
 * standing allowance of 10 (October's grandfathered 25 is currently hiding
 * this), a customer could spend most of the month looking around and have the
 * first question they cared about refused by work they never asked for.
 *
 * ## The rule, and the one that was rejected
 *
 * An intermediate version capped automatic work at half the allowance. That
 * still charged browsing to the customer, just more slowly, and it is not what
 * was wanted. **Automatic generation is not metered at all**: it uses the
 * deterministic engine, which makes no external request. Only an explicit
 * action spends a request, and it may spend the whole allowance.
 *
 * So the assertions here are of two kinds — that an explicit action is still
 * metered exactly as before, and that nothing in the automatic path can reach a
 * reservation. The second is asserted against the source, because the defect
 * would be a call that should not exist rather than one that behaves wrongly.
 */

let tenant: Tenant;
const period = currentPeriod();

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

describe("an explicit action spends the whole allowance", () => {
  test("every request up to the allowance is granted, and the next is refused", async () => {
    const actor = await actorFor(tenant);
    const allowance = aiAllowanceFor(PLANS.free, period);
    assert.ok(allowance > 1, "the Free allowance is not a useful fixture");

    for (let i = 0; i < allowance; i += 1) await reserveAiOrThrow(actor);
    assert.equal(await usage(tenant.ownerId), allowance, "the customer could not reach their allowance");

    await assert.rejects(
      () => reserveAiOrThrow(actor),
      /allowance|used all/i,
      "the allowance was not enforced once fully spent",
    );
    assert.equal(
      await usage(tenant.ownerId),
      allowance,
      "a refused request still incremented the counter",
    );
  });

  test("the refusal names the number that refused them", async () => {
    const actor = await actorFor(tenant);
    const allowance = aiAllowanceFor(PLANS.free, period);
    for (let i = 0; i < allowance; i += 1) await reserveAiOrThrow(actor);

    const error = await reserveAiOrThrow(actor).then(() => null, (e: unknown) => e);
    assert.ok(error instanceof Error);
    assert.match(
      error.message,
      new RegExp(String(allowance)),
      "the message quotes a different number than the one enforced",
    );
  });

  test("concurrent explicit requests cannot exceed the allowance", async () => {
    // The reservation is one atomic statement rather than a read then a write,
    // because two concurrent requests could both pass a read-only check and
    // both call a paid API.
    const actor = await actorFor(tenant);
    const allowance = aiAllowanceFor(PLANS.free, period);

    const results = await Promise.all(
      Array.from({ length: allowance + 8 }, () =>
        reserveAiOrThrow(actor).then(() => true, () => false),
      ),
    );
    assert.equal(results.filter(Boolean).length, allowance);
    assert.equal(await usage(tenant.ownerId), allowance);
  });
});

describe("automatic generation is never metered", () => {
  test("nothing in the automatic path reserves anything", async () => {
    /**
     * Asserted against the source, because the defect this prevents is a call
     * that should not be there. Both functions resolve a provider and then
     * branch: an explicit action reserves, and everything else is handed to the
     * deterministic engine. A reservation reachable from the `else` would be
     * the original bug back again, and it would be invisible in behaviour until
     * somebody's allowance drained from browsing.
     */
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/lib/ai/summaries.ts"), "utf8");

    for (const fn of ["getRecordSummary", "getDailyBrief"]) {
      const start = source.indexOf(`export async function ${fn}`);
      assert.ok(start > -1, `${fn} is no longer exported`);
      const body = source.slice(start, source.indexOf("\n}", start));

      const branch = body.match(
        /if \(provider\.id !== "offline"\) \{\s*if \(userAsked\(options\)\) \{\s*await reserveAiOrThrow\(actor\);\s*\} else \{\s*provider = offlineProvider\(\);\s*\}\s*\}/,
      );
      assert.ok(
        branch,
        `${fn} does not metre only explicit actions — expected the reservation under ` +
          `userAsked(options) and the offline engine otherwise`,
      );

      // Exactly one reservation in the function, and it is the one above.
      assert.equal(
        [...body.matchAll(/reserveAi\w*\(/g)].length,
        1,
        `${fn} reaches a reservation more than once`,
      );
    }
  });

  test("no automatic-work reservation exists to be called", async () => {
    // The half-allowance version is gone, not merely unused. An exported
    // function that meters automatic work would eventually be called.
    const entitlements = await import("../../src/lib/entitlements");
    assert.equal(
      "reserveAutomaticAi" in entitlements,
      false,
      "an automatic reservation is still exported and will find its way back into a call site",
    );
    assert.equal("AUTOMATIC_ALLOWANCE_SHARE" in entitlements, false);
  });

  test("the offline provider is what the automatic path falls back to", async () => {
    const { offlineProvider } = await import("../../src/lib/ai/provider");
    const { resetProvider, setProviderForTests } = await import("../../src/lib/ai/provider");
    setProviderForTests(null);
    resetProvider();
    assert.equal(offlineProvider().id, "offline", "the automatic fallback is not the local engine");
  });
});
