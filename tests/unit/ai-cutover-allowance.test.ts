import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  PLANS,
  PRE_STRIPE_FREE_AI_ALLOWANCE,
  PRICING_CUTOVER_PERIOD,
  aiAllowanceFor,
  isCutoverPeriod,
  planFor,
} from "../../src/lib/plans";

/**
 * The pricing cutover grandfather.
 *
 * Shipping the new allowances mid-month measures requests a Free account already
 * made under the old published ceiling of 25 against the new ceiling of 10, and
 * refuses them for the rest of the month. These tests pin the three properties
 * that make the grandfather safe rather than merely generous: it applies to the
 * cutover period, it applies to nothing else, and the number it produces is the
 * number that is enforced *and* displayed.
 *
 * Mutation-checked: removing the cutover branch from `aiAllowanceFor` fails the
 * first test; widening it to every period fails the second; widening it to every
 * plan fails the third; and reading `plan.limits.aiRequestsPerMonth` directly in
 * either settings page fails the last.
 */
describe("the pricing cutover AI allowance", () => {
  const CUTOVER = PRICING_CUTOVER_PERIOD;
  const free = planFor("free");

  test("the constant is a usage-period key, or deliberately off", () => {
    assert.ok(
      CUTOVER === null || /^\d{4}-(0[1-9]|1[0-2])$/.test(CUTOVER),
      `PRICING_CUTOVER_PERIOD must be yyyy-MM or null, got ${String(CUTOVER)}`,
    );
  });

  test("the old allowance is above the new one, or the grandfather is pointless", () => {
    assert.ok(
      PRE_STRIPE_FREE_AI_ALLOWANCE > free.limits.aiRequestsPerMonth,
      "If Free's allowance is no longer a reduction, delete the grandfather instead of " +
        "keeping a constant that does nothing.",
    );
  });

  test("a Free account keeps the old allowance for the cutover period", () => {
    if (CUTOVER === null) return;
    assert.equal(aiAllowanceFor(free, CUTOVER), PRE_STRIPE_FREE_AI_ALLOWANCE);
    assert.ok(isCutoverPeriod(CUTOVER));
  });

  test("the following period is on the new allowance", () => {
    if (CUTOVER === null) return;
    const [y, m] = CUTOVER.split("-").map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    assert.equal(aiAllowanceFor(free, next), free.limits.aiRequestsPerMonth);
    assert.ok(!isCutoverPeriod(next));
    // And a period before it, which nobody can be mid-way through, is unaffected.
    const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    assert.equal(aiAllowanceFor(free, prev), free.limits.aiRequestsPerMonth);
  });

  test("no plan other than Free is touched, in any period", () => {
    if (CUTOVER === null) return;
    for (const id of Object.keys(PLANS) as (keyof typeof PLANS)[]) {
      if (id === "free") continue;
      const plan = PLANS[id];
      assert.equal(
        aiAllowanceFor(plan, CUTOVER),
        plan.limits.aiRequestsPerMonth,
        `${id} must keep its standing allowance during the cutover`,
      );
    }
  });

  test("the Free-only guard holds for a plan priced below the old Free allowance", () => {
    // Every plan we sell today has an allowance above 25, so the loop above cannot
    // observe the `plan.id !== "free"` guard at all: `max(30, 25)` is 30 whether
    // the guard runs or not. Mutation testing caught exactly that — deleting the
    // guard passed the whole file. The property the guard actually carries is that
    // the grandfather belongs to Free's *history*, not to any plan that happens to
    // be cheap, so it is asserted against a plan that would otherwise be raised.
    if (CUTOVER === null) return;
    const cheapPaid = {
      ...PLANS.plus,
      id: "plus" as const,
      limits: { ...PLANS.plus.limits, aiRequestsPerMonth: 5 },
    };
    assert.equal(
      aiAllowanceFor(cheapPaid, CUTOVER),
      5,
      "Only Free carries the pre-release allowance. A paid plan below it must not be raised.",
    );
  });

  test("a raised standing allowance is never lowered by the grandfather", () => {
    // The `max` in aiAllowanceFor, stated as a property: if Free's allowance were
    // ever raised above the old figure, the cutover must not pull it back down.
    const raised = { ...free, limits: { ...free.limits, aiRequestsPerMonth: 99 } };
    assert.equal(aiAllowanceFor(raised, CUTOVER ?? "2026-10"), 99);
  });

  test("enforcement and both displays read the effective allowance, not the standing one", () => {
    const root = resolve(import.meta.dirname, "../..");
    // Every file that reads the raw figure must be one that is allowed to: the
    // plan table itself, the marketing pages (which advertise the standing plan),
    // and the module that computes the effective number.
    const ALLOWED = new Set([
      "src/lib/plans.ts",
      "src/app/(marketing)/terms/page.tsx",
      "src/instrumentation.ts",
    ]);
    const found = execFileSync(
      "grep",
      ["-rl", "limits.aiRequestsPerMonth", "src", "--include=*.ts", "--include=*.tsx"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);

    for (const file of found) {
      assert.ok(
        ALLOWED.has(file),
        `${file} reads plan.limits.aiRequestsPerMonth directly. Use aiAllowanceFor(plan, ` +
          `currentPeriod()) so the ceiling shown is the ceiling enforced.`,
      );
    }

    // And the three readers that matter must actually call the helper.
    for (const file of [
      "src/lib/entitlements.ts",
      "src/app/(app)/settings/ai/page.tsx",
      "src/app/(app)/settings/billing/page.tsx",
    ]) {
      const src = readFileSync(resolve(root, file), "utf8");
      assert.match(src, /aiAllowanceFor\(/, `${file} must resolve the allowance through aiAllowanceFor`);
    }
  });
});
