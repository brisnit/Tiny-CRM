/**
 * What a metered AI request can cost, bounded.
 *
 * This file exists because an earlier pricing pass sized the monthly AI
 * allowances against a number that was not a ceiling. It multiplied a *typical*
 * input by `max_tokens` and called the result a worst case. Three things were
 * missing, and each of them is a real multiplier on the bill:
 *
 *   1. **`max_tokens` bounds output only.** Input was unbounded in practice:
 *      the agent assembled a 14,000-char context, six history messages of up to
 *      4,000 chars each, and a 4,000-char question — 42,000 chars, around seven
 *      times the figure the estimate assumed.
 *   2. **Retries bill.** The Anthropic and OpenAI SDKs both retry twice by
 *      default, so one logical request was up to three charged attempts. Nothing
 *      in the application knew that; `recordUsage` counted one.
 *   3. **Thinking tokens are output tokens.** Adaptive thinking is on, and what
 *      it produces is billed at the output rate inside the same `max_tokens`
 *      budget. That part the old estimate got right by accident.
 *
 * So the ceiling here is the product of three *enforced* bounds — a prompt
 * character budget, a per-purpose output cap, and a hard attempt count — priced
 * at the configured model's published rates. If any of those stops being
 * enforced, `tests/unit/ai-cost-model.test.ts` fails rather than the invoice
 * growing quietly.
 *
 * What this file deliberately does **not** claim to bound: hosting, database,
 * object storage, Stripe fees, or the aggregate exposure of many free accounts.
 * Those are real costs and they are not per-request. See docs/AI-COST-MODEL.md.
 */

/**
 * Published per-million-token rates, Claude API first-party, USD.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * Verified 2026-10-01. These are standard rates — not batch (50% less), not fast
 * mode (2x), not the 1.1x US data-residency multiplier, none of which this
 * deployment uses.
 *
 * A model missing from this table is **unpriced**, and `requestCeilingUsd`
 * returns null for it rather than guessing. That is the safe direction: an
 * unpriced model makes the cost test fail loudly instead of certifying an
 * allowance nobody has costed.
 */
export const MODEL_RATES: Readonly<Record<string, { inputPerMTok: number; outputPerMTok: number }>> = {
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

/**
 * The total character budget for everything sent to a model in one request:
 * system prompt, assembled context, prior turns and the question together.
 *
 * Enforced in src/lib/ai/prompt-budget.ts at the point of assembly, not merely
 * documented here. 16,000 characters is roughly 3,000 words of context, which
 * the record and workspace context builders already fit inside; both truncate
 * with a visible marker rather than failing.
 */
export const MAX_PROMPT_CHARS = 16_000;

/**
 * Characters per token, for converting the budget into a token bound.
 *
 * Claude 4.7 and later use a tokenizer that produces roughly 30% more tokens for
 * the same text than earlier models, which the pricing page states explicitly.
 * The familiar "4 characters per token" rule therefore understates Opus 5 by
 * about a third. 3.0 is that figure rounded against us, so the bound errs high.
 */
export const CHARS_PER_TOKEN = 3.0;

/**
 * Charged attempts per logical request.
 *
 * The SDK default is 2 retries — three attempts. `maxRetries: 1` in
 * src/lib/ai/provider.ts brings that to two, keeping one retry for a transient
 * 429 or 5xx while halving the worst case. Zero would be cheaper and less
 * reliable; this is the trade, stated once.
 */
export const MAX_ATTEMPTS = 2;

/**
 * Output ceilings per metered call site, mirroring the `maxTokens` each one
 * passes. Kept here as well so the cost test reads one table instead of
 * grepping five call sites — and so a raised cap has to be raised twice, which
 * is the point.
 */
export const OUTPUT_CAPS: Readonly<Record<MeteredPurpose, number>> = {
  agent: 2_000,
  document: 1_200,
  record_summary: 700,
  classification: 1_400,
};

export type MeteredPurpose = "agent" | "document" | "record_summary" | "classification";

/** The input token bound implied by the prompt budget. */
export function maxInputTokens(): number {
  return Math.ceil(MAX_PROMPT_CHARS / CHARS_PER_TOKEN);
}

/**
 * The most one metered request of this kind can cost, in USD.
 *
 * Null when the model has no published rate in `MODEL_RATES`.
 */
export function requestCeilingUsd(model: string, purpose: MeteredPurpose): number | null {
  const rate = MODEL_RATES[model];
  if (!rate) return null;

  const input = maxInputTokens();
  const output = OUTPUT_CAPS[purpose];
  const perAttempt = (input * rate.inputPerMTok + output * rate.outputPerMTok) / 1_000_000;
  return perAttempt * MAX_ATTEMPTS;
}

/** The costliest purpose, which is what a monthly allowance must be sized against. */
export function worstRequestCeilingUsd(model: string): number | null {
  const each = (Object.keys(OUTPUT_CAPS) as MeteredPurpose[]).map((p) => requestCeilingUsd(model, p));
  if (each.some((v) => v === null)) return null;
  return Math.max(...(each as number[]));
}

/**
 * A representative request, for the expected-case figure.
 *
 * Half the prompt budget and a 500-token answer, with no retry — the shape of an
 * ordinary "what should I do today" question. This is an estimate and is
 * labelled as one everywhere it is reported; only `requestCeilingUsd` is a
 * bound.
 */
export function typicalRequestUsd(model: string, purpose: MeteredPurpose = "agent"): number | null {
  const rate = MODEL_RATES[model];
  if (!rate) return null;
  const input = maxInputTokens() / 2;
  const output = Math.min(500, OUTPUT_CAPS[purpose]);
  return (input * rate.inputPerMTok + output * rate.outputPerMTok) / 1_000_000;
}

/** Worst-case monthly model spend for one account on an allowance of `requests`. */
export function monthlyCeilingUsd(model: string, requests: number): number | null {
  const worst = worstRequestCeilingUsd(model);
  return worst === null ? null : worst * requests;
}

/**
 * Stripe's published fee for a domestic card, applied to a monthly price.
 *
 * 2.9% + $0.30. Used to turn a sticker price into the net the allowance is
 * actually sized against, because the gross figure overstates what is available
 * by six percent on a $10 plan.
 */
export function netOfStripeFeesUsd(priceCents: number): number {
  if (priceCents <= 0) return 0;
  const gross = priceCents / 100;
  return gross - (gross * 0.029 + 0.3);
}

/**
 * The share of net revenue a plan's worst-case model spend may consume.
 *
 * Half. The remainder covers hosting, the database, object storage and margin.
 * This is the dial that decides every paid allowance, so it is one named
 * constant rather than an arithmetic step buried in a comment.
 */
export const MAX_AI_SHARE_OF_NET = 0.5;

/** The largest allowance a monthly price can carry at the configured model. */
export function affordableRequests(model: string, priceCents: number): number | null {
  const worst = worstRequestCeilingUsd(model);
  if (worst === null) return null;
  const budget = netOfStripeFeesUsd(priceCents) * MAX_AI_SHARE_OF_NET;
  return Math.floor(budget / worst);
}
