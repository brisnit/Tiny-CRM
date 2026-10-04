import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CHARS_PER_TOKEN, MAX_AI_SHARE_OF_NET, MAX_ATTEMPTS, MAX_PROMPT_CHARS, MODEL_RATES,
  OUTPUT_CAPS, affordableRequests, maxInputTokens, monthlyCeilingUsd,
  netOfStripeFeesUsd, requestCeilingUsd, typicalRequestUsd, worstRequestCeilingUsd,
} from "../../src/lib/ai/cost";
import { PLANS, PLAN_ORDER, type PlanId } from "../../src/lib/plans";

/**
 * The guard on the AI allowances.
 *
 * An earlier pricing pass sized the monthly allowances against a figure it called
 * a worst case and wasn't: it multiplied a *typical* input by `max_tokens`,
 * counted one attempt where the SDK made three, and left input unbounded. The
 * published allowances were roughly two and a half times what the plans could
 * afford.
 *
 * The fix is not a more careful sum in a comment. It is that the ceiling is
 * computed from constants that are actually enforced, and that this suite fails
 * when any of them moves: a different model, a raised output cap, a widened
 * prompt budget, an extra retry. Each of those is a legitimate change to want;
 * none of them should be possible without the pricing being reconsidered in the
 * same commit.
 *
 * The model is deliberately pessimistic. Where a figure could be rounded either
 * way it is rounded against us, so the real bill comes in under the bound rather
 * than over it.
 */

const ROOT = resolve(import.meta.dirname, "../..");
const CONFIGURED_MODEL = "claude-opus-5";

describe("the AI cost model is grounded in enforced bounds", () => {
  test("the configured model has a published rate", () => {
    // An unpriced model is the one case where the model must refuse to produce a
    // number, because a guessed rate would certify an allowance nobody costed.
    assert.ok(
      MODEL_RATES[CONFIGURED_MODEL],
      `${CONFIGURED_MODEL} must appear in MODEL_RATES with rates from the published pricing page`,
    );
    assert.equal(requestCeilingUsd("a-model-nobody-priced", "agent"), null);
    assert.equal(worstRequestCeilingUsd("a-model-nobody-priced"), null);
    assert.equal(monthlyCeilingUsd("a-model-nobody-priced", 100), null);
  });

  test("the default model in env.ts is the one the allowances were costed against", () => {
    // If someone changes the default model, the allowances in plans.ts were
    // priced for a different one. That is exactly the drift this file exists to
    // catch, and it is invisible in a diff that only touches env.ts.
    const envSource = readFileSync(resolve(ROOT, "src/lib/env.ts"), "utf8");
    const match = /anthropicModel:\s*optional\("ANTHROPIC_MODEL"\)\s*\?\?\s*"([^"]+)"/.exec(envSource);
    assert.ok(match, "could not find the ANTHROPIC_MODEL default in src/lib/env.ts");
    assert.equal(
      match![1],
      CONFIGURED_MODEL,
      "the default model changed — re-cost every plan allowance before updating this test",
    );
  });

  test("the attempt bound in the cost model is the one the SDK clients are built with", () => {
    // The ceiling multiplies by MAX_ATTEMPTS. If the clients retry more often
    // than that, the ceiling is fiction.
    const provider = readFileSync(resolve(ROOT, "src/lib/ai/provider.ts"), "utf8");
    const retryLines = provider.match(/maxRetries:\s*[^,\n]+/g) ?? [];
    assert.ok(retryLines.length >= 2, "both SDK clients must set maxRetries explicitly");
    for (const line of retryLines) {
      assert.match(
        line,
        /MAX_ATTEMPTS\s*-\s*1/,
        `maxRetries must be derived from MAX_ATTEMPTS, found: ${line}`,
      );
    }
  });

  test("no provider call site may exceed the output caps the model prices", () => {
    const largestPriced = Math.max(...Object.values(OUTPUT_CAPS));
    const sources = [
      "src/lib/ai/crm-agent.ts",
      "src/lib/ai/document-agent.ts",
      "src/lib/ai/summaries.ts",
      "src/lib/ai/classification.ts",
      "src/lib/ai/provider.ts",
    ];
    for (const rel of sources) {
      const text = readFileSync(resolve(ROOT, rel), "utf8");
      for (const m of text.matchAll(/max_?Tokens:\s*([0-9_]+)/gi)) {
        const value = Number(m[1]!.replace(/_/g, ""));
        assert.ok(
          value <= largestPriced,
          `${rel} requests ${value} output tokens, above the largest priced cap (${largestPriced}). ` +
            `Raise OUTPUT_CAPS and re-cost the allowances, or lower the request.`,
        );
      }
    }
  });

  test("the input bound follows from the prompt budget, pessimistically", () => {
    // 3.0 chars/token, not the familiar 4.0: Claude 4.7+ tokenizers produce
    // about 30% more tokens for the same text, so 4.0 would understate the bill
    // by a third on the configured model.
    assert.ok(CHARS_PER_TOKEN <= 3.1, "chars-per-token must stay pessimistic for the 4.7+ tokenizer");
    assert.equal(maxInputTokens(), Math.ceil(MAX_PROMPT_CHARS / CHARS_PER_TOKEN));
  });

  test("Stripe fees are taken off before an allowance is sized", () => {
    // A $10 plan does not yield $10. Sizing against gross overstates the budget
    // by six percent on Plus, which is most of the margin.
    const net = netOfStripeFeesUsd(1000);
    assert.ok(net > 9.3 && net < 9.5, `expected ~$9.41 net on a $10 plan, got ${net}`);
    assert.equal(netOfStripeFeesUsd(0), 0, "a free plan has no fee to deduct");
  });

  test("every purchasable paid plan's worst case stays within its revenue share", () => {
    const worst = worstRequestCeilingUsd(CONFIGURED_MODEL);
    assert.ok(worst !== null);

    for (const id of PLAN_ORDER) {
      const plan = PLANS[id];
      if (plan.priceCents === 0) continue;

      const allowance = plan.limits.aiRequestsPerMonth;
      const ceiling = worst! * allowance;
      const net = netOfStripeFeesUsd(plan.priceCents);
      const share = ceiling / net;

      assert.ok(
        share <= MAX_AI_SHARE_OF_NET,
        `${plan.name}: ${allowance} requests could cost $${ceiling.toFixed(2)}, ` +
          `${Math.round(share * 100)}% of $${net.toFixed(2)} net — over the ${Math.round(MAX_AI_SHARE_OF_NET * 100)}% ceiling. ` +
          `Affordable allowance is ${affordableRequests(CONFIGURED_MODEL, plan.priceCents)}.`,
      );
    }
  });

  test("each paid allowance is close to the largest affordable one", () => {
    // The complement of the test above, which only stops an allowance being too
    // generous. This stops one being quietly stingy: a plan priced for 62
    // requests should not ship 20 and pocket the difference.
    //
    // A small rounding-down margin is allowed so an allowance can be a number a
    // customer can hold in their head — 60 rather than 62. The margin is tight
    // enough that it cannot hide a real reduction.
    const MARGIN = 0.95;
    for (const id of PLAN_ORDER) {
      const plan = PLANS[id];
      if (plan.priceCents === 0) continue;
      const affordable = affordableRequests(CONFIGURED_MODEL, plan.priceCents)!;
      const actual = plan.limits.aiRequestsPerMonth;

      assert.ok(
        actual <= affordable,
        `${plan.name} carries ${actual} requests but can only afford ${affordable}`,
      );
      assert.ok(
        actual >= Math.floor(affordable * MARGIN),
        `${plan.name} carries ${actual} requests and could afford ${affordable} — ` +
          `more than a rounding margin is being left unused`,
      );
    }
  });

  test("the free allowance is a bounded, deliberate acquisition cost", () => {
    const free = PLANS.free.limits.aiRequestsPerMonth;
    const ceiling = monthlyCeilingUsd(CONFIGURED_MODEL, free);
    assert.ok(ceiling !== null);
    // Free earns nothing, so the only question is whether the per-account
    // exposure is small and bounded. Two dollars is the line; above that the
    // aggregate across signups stops being a rounding error.
    assert.ok(
      ceiling! <= 2,
      `a free account could cost $${ceiling!.toFixed(2)} of model spend; keep it under $2`,
    );
    assert.ok(free > 0, "free must be able to try the model at least once");
  });

  test("the typical figure is lower than the ceiling and is never used as a bound", () => {
    const typical = typicalRequestUsd(CONFIGURED_MODEL, "agent");
    const ceiling = requestCeilingUsd(CONFIGURED_MODEL, "agent");
    assert.ok(typical !== null && ceiling !== null);
    assert.ok(typical! < ceiling!, "a typical request must cost less than the bound");
  });

  test("legacy plans are not sized by this model, and are not sold", () => {
    // Their allowances are preserved from the pre-Stripe plans deliberately, so
    // they are exempt from the affordability rule — but they must never appear
    // in a picker, which is what keeps the exemption from becoming a product.
    const legacy: PlanId[] = ["legacy_pro", "legacy_lifetime"];
    for (const id of legacy) {
      assert.equal(PLANS[id].purchasable, false, `${id} must not be purchasable`);
      assert.ok(!PLAN_ORDER.includes(id), `${id} must not appear in PLAN_ORDER`);
    }
  });

  test("a cheaper model would buy a larger allowance — recorded, not applied", () => {
    // Documents the lever without pulling it. If this ever fails, the rate table
    // has changed in a way that makes the trade-off different from what
    // docs/AI-COST-MODEL.md tells the reader.
    const opus = affordableRequests("claude-opus-5", 1000);
    const sonnet = affordableRequests("claude-sonnet-5", 1000);
    const haiku = affordableRequests("claude-haiku-4-5", 1000);
    assert.ok(opus !== null && sonnet !== null && haiku !== null);
    assert.ok(sonnet! > opus!, "Sonnet 5 should afford more requests than Opus 5");
    assert.ok(haiku! > sonnet!, "Haiku 4.5 should afford more requests than Sonnet 5");
  });

  test("MAX_ATTEMPTS counts attempts, not retries", () => {
    // Off-by-one here doubles or halves every ceiling in the file.
    assert.ok(MAX_ATTEMPTS >= 1, "there is always at least one attempt");
    const single = requestCeilingUsd(CONFIGURED_MODEL, "agent")! / MAX_ATTEMPTS;
    const rate = MODEL_RATES[CONFIGURED_MODEL]!;
    const expected =
      (maxInputTokens() * rate.inputPerMTok + OUTPUT_CAPS.agent * rate.outputPerMTok) / 1_000_000;
    assert.ok(Math.abs(single - expected) < 1e-9, "per-attempt cost must match the rate arithmetic");
  });
});
