import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { FLAGS } from "../../src/lib/flags";
import {
  ENFORCED_LIMITS, PLANS, PLAN_ORDER, PRE_STRIPE_PLAN_ALIASES, UNLIMITED,
  advertisedFeatures, planFor, type PlanId,
} from "../../src/lib/plans";

/**
 * Pricing copy must agree with what the application enforces.
 *
 * Three ways it had already drifted before this suite existed:
 *
 *   1. The marketing page said "$14/month · or $250 once" long after those were
 *      the numbers in plans.ts.
 *   2. Pro advertised "Automations, saved views and custom fields" and "Email and
 *      calendar integrations". Three of those five have no write path anywhere in
 *      the codebase — `automation.create`, `savedView.create` and
 *      `integration.create` appear nowhere — so they were features in copy only.
 *   3. "Up to 5 seats" was advertised and never enforced: the entitlement
 *      function that computed it had no callers.
 *
 * Copy is not self-checking and review did not catch any of the three. These
 * tests are the control.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

/** Surfaces that quote a price or describe what a plan includes. */
const COPY_FILES = [
  "src/app/(marketing)/page.tsx",
  "src/components/marketing/pricing.tsx",
  "src/app/(app)/settings/billing/page.tsx",
  "src/app/(app)/settings/ai/page.tsx",
  // Holds the product and price descriptions Stripe shows on hosted checkout
  // and in the Customer Portal, so it is customer-facing copy too.
  "scripts/lib/stripe-catalogue.mjs",
];

/**
 * Capabilities with no write path in the application. Advertising one of these is
 * the mistake this list exists to prevent; remove an entry when the feature is
 * actually built.
 */
const UNIMPLEMENTED = [
  { word: "automation", why: "no automation.create exists anywhere in src/" },
  { word: "saved view", why: "no savedView.create exists anywhere in src/" },
  { word: "calendar integration", why: "integrations are a read-only placeholder; no connect path" },
  { word: "email integration", why: "integrations are a read-only placeholder; no connect path" },
];

describe("pricing copy agrees with the product", () => {
  test("every price quoted in copy is a price some plan actually charges", () => {
    const real = new Set(
      Object.values(PLANS)
        .filter((p) => p.priceCents > 0)
        .map((p) => `$${p.priceCents / 100}`),
    );
    real.add("$0");

    for (const rel of COPY_FILES) {
      const text = read(rel);
      // Dollar figures that look like a plan price: one to four digits, no
      // decimals, not part of a larger token. Deliberately narrow — the product
      // preview contains deal values like "$145K" and those are not prices.
      for (const m of text.matchAll(/\$(\d{1,4})(?![\dKkMm.])/g)) {
        const quoted = `$${m[1]}`;
        assert.ok(
          real.has(quoted),
          `${rel} quotes ${quoted}, which no plan charges. Plan prices are ${[...real].join(", ")}.`,
        );
      }
    }
  });

  test("no copy advertises a capability that has no write path", () => {
    for (const rel of COPY_FILES) {
      const text = read(rel).toLowerCase();
      for (const { word, why } of UNIMPLEMENTED) {
        assert.ok(
          !text.includes(word),
          `${rel} advertises "${word}" — ${why}. Remove the copy or build the feature.`,
        );
      }
    }
  });

  test("no plan advertises a capability it has no write path for", () => {
    for (const plan of Object.values(PLANS)) {
      const all = [...plan.features, ...(plan.gatedFeatures ?? []).map((f) => f.text)]
        .join(" ")
        .toLowerCase();
      for (const { word, why } of UNIMPLEMENTED) {
        assert.ok(!all.includes(word), `${plan.name} advertises "${word}" — ${why}`);
      }
    }
  });

  test("a gated feature names a real flag and is not advertised while it is off", () => {
    for (const plan of Object.values(PLANS)) {
      for (const gated of plan.gatedFeatures ?? []) {
        assert.ok(
          gated.flag in FLAGS,
          `${plan.name} gates a feature on "${gated.flag}", which is not a flag in FLAGS`,
        );
        // With no flags enabled, a gated line must not appear.
        assert.ok(
          !advertisedFeatures(plan, []).includes(gated.text),
          `${plan.name} advertises a ${gated.flag}-gated line even when the flag is off`,
        );
        assert.ok(
          advertisedFeatures(plan, [gated.flag]).includes(gated.text),
          `${plan.name} does not advertise its ${gated.flag} line even when the flag is on`,
        );
      }
    }
  });

  test("document question answering is gated, not promised outright", () => {
    // The specific case this mechanism was built for. The entitlement is part of
    // Pro; the capability is still dark behind `documentAi`, and it must not be
    // advertised until the flag is on and a real grounded answer has been seen in
    // production.
    assert.equal(FLAGS.documentAi.default, false, "documentAi still ships dark");
    assert.ok(PLANS.pro.capabilities.documentQa, "Pro grants the entitlement");

    const gated = PLANS.pro.gatedFeatures?.find((f) => f.flag === "documentAi");
    assert.ok(gated, "the document line is a gated feature, not an unconditional one");

    const unconditional = PLANS.pro.features.join(" ").toLowerCase();
    for (const word of ["pdf", "document", "citation"]) {
      assert.ok(
        !unconditional.includes(word),
        `Pro's unconditional features mention "${word}" — move it to gatedFeatures`,
      );
    }
  });

  test("every advertised number matches the enforced limit", () => {
    // A feature line saying "2,000 contacts" has to be the number
    // assertWithinLimit uses. This checks the digits that appear in copy against
    // the plan's own limits rather than trusting them to be kept in step.
    for (const id of PLAN_ORDER) {
      const plan = PLANS[id];
      const limits = new Set<string>();
      for (const key of ENFORCED_LIMITS) {
        const value = plan.limits[key];
        if (value !== UNLIMITED) {
          limits.add(value.toLocaleString("en-US"));
          limits.add(String(value));
        }
      }

      for (const line of [...plan.features, ...(plan.gatedFeatures ?? []).map((f) => f.text)]) {
        for (const m of line.matchAll(/\b(\d[\d,]*)\b/g)) {
          assert.ok(
            limits.has(m[1]!),
            `${plan.name} advertises "${m[1]}" in "${line}" but no enforced limit has that value. ` +
              `Enforced values: ${[...limits].sort().join(", ")}`,
          );
        }
      }
    }
  });

  test("only purchasable plans appear in the order the pricing page renders", () => {
    for (const id of PLAN_ORDER) {
      assert.ok(PLANS[id].purchasable, `${id} is in PLAN_ORDER but is not purchasable`);
    }
    const legacy = (Object.keys(PLANS) as PlanId[]).filter((id) => !PLANS[id].purchasable);
    assert.ok(legacy.length > 0, "legacy plans must still resolve for accounts holding them");
  });

  test("no copy promises unlimited usage on a plan that is sold", () => {
    for (const id of PLAN_ORDER) {
      const plan = PLANS[id];
      const text = [...plan.features, ...(plan.gatedFeatures ?? []).map((f) => f.text)]
        .join(" ")
        .toLowerCase();
      // "Unlimited built-in insights" is true and deliberate: the deterministic
      // engine makes no external request and costs nothing per use. Any other
      // unlimited claim on a sold plan is the thing to catch.
      for (const m of text.matchAll(/unlimited ([a-z -]+)/g)) {
        const subject = m[1]!.trim();
        assert.ok(
          subject.startsWith("built-in"),
          `${plan.name} promises "unlimited ${subject}", but every sold limit is finite`,
        );
      }
      for (const key of ENFORCED_LIMITS) {
        assert.notEqual(
          plan.limits[key],
          UNLIMITED,
          `${plan.name} has an unlimited ${key}, which a sold plan must not`,
        );
      }
    }
  });
});

describe("the plan rename cannot strip an account on either side of the deploy", () => {
  /**
   * A vocabulary change spans a database and a deployment, and they cannot change
   * at the same instant. Both orderings were checked by executing the *deployed*
   * `planFor` against the migrated values, and both lost access:
   *
   *   migrate first  -> deployed code does not know `legacy_*`, falls back to Free
   *   deploy first   -> new code dropped the key `lifetime`, falls back to Free
   *
   * The alias fixes the second. These tests pin it, and pin the deliberate
   * decision not to alias `pro`.
   */
  const unlimited = Number.POSITIVE_INFINITY;

  test("a stored `lifetime` keeps its unlimited entitlements under the new code", () => {
    const resolved = planFor("lifetime");
    assert.equal(resolved.id, "legacy_lifetime", "the old id resolves to the preserved plan");
    assert.equal(resolved.limits.contacts, unlimited, "and keeps unlimited records");
    assert.equal(resolved.limits.aiRequestsPerMonth, 2_000, "and its original AI allowance");
    assert.equal(resolved.purchasable, false, "while never being offered for sale");
  });

  test("the migrated id resolves identically, so the migration changes nothing observable", () => {
    const before = planFor("lifetime");
    const after = planFor("legacy_lifetime");
    assert.deepEqual(
      after.limits,
      before.limits,
      "an account's entitlements must be the same before and after its row is rewritten",
    );
  });

  test("`pro` is NOT aliased, because it means two different things", () => {
    // Aliasing it would hand unlimited records to every future Pro subscriber.
    assert.ok(!("pro" in PRE_STRIPE_PLAN_ALIASES), "pro must not be aliased");
    const current = planFor("pro");
    assert.equal(current.id, "pro");
    assert.notEqual(current.limits.contacts, unlimited, "the sold Pro has a finite ceiling");
  });

  test("every alias points at a real, non-purchasable plan", () => {
    for (const [oldId, target] of Object.entries(PRE_STRIPE_PLAN_ALIASES)) {
      assert.ok(PLANS[target], `${oldId} aliases ${target}, which is not a plan`);
      assert.equal(PLANS[target].purchasable, false, `${target} must not be sellable`);
      assert.ok(!(oldId in PLANS), `${oldId} should be an alias, not a plan key`);
    }
  });

  test("an unknown plan id still falls back to Free, so the alias did not widen anything", () => {
    assert.equal(planFor("something_else").id, "free");
    assert.equal(planFor(null).id, "free");
    assert.equal(planFor(undefined).id, "free");
  });
});
