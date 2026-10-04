# What Tiny AI costs, and what bounds it

This document exists because the first version of the Free / Plus / Pro pricing
was sized against a number that was presented as a worst case and was not one.
It is worth writing down how that happened, because the mistake is easy to repeat.

## The mistake

The original estimate multiplied a *typical* input by `max_tokens` and called the
product a per-request ceiling. Three things were missing:

1. **`max_tokens` bounds output only.** Input was unbounded in practice. The
   agent path assembled a context of up to 14,000 characters, six prior turns of
   up to 4,000 characters each, and a 4,000-character question — about 42,000
   characters, roughly seven times what the estimate assumed. Input tokens are
   billed.
2. **Retries bill.** Both the Anthropic and OpenAI SDKs default to two retries,
   so one logical request was up to three charged attempts. The application
   counted one.
3. **Thinking tokens are output tokens.** Adaptive thinking is on, and what it
   produces is billed at the output rate.

The published allowances were therefore about two and a half times what the plans
could afford. Nothing had gone wrong yet only because production had no working
API key.

## What bounds a request now

Three enforced bounds, each in code rather than in this document:

| Bound | Value | Enforced in |
|---|---|---|
| Total prompt characters | 16,000 | `fitContext` in `src/lib/ai/prompt-budget.ts`, called by `withContext`; `fitMessages` in both provider clients |
| Output tokens | 2,000 agent / 1,400 classification / 1,200 document / 700 summary | `maxTokens` at each call site, mirrored in `OUTPUT_CAPS` |
| Charged attempts | 2 | `maxRetries: MAX_ATTEMPTS - 1` on both SDK clients |

`tests/unit/ai-cost-model.test.ts` fails if any of them moves: a changed default
model, a raised output cap, a widened budget, an extra retry. Each is a
legitimate change to want; none should be possible without the pricing being
reconsidered in the same commit.

Two bounds deserve a note:

- **Characters, not tokens.** A character budget is enforceable at assembly time
  without a tokenizer round-trip. It converts to tokens at 3.0 characters per
  token, which is deliberately pessimistic: Claude 4.7 and later use a tokenizer
  that produces roughly 30% more tokens for the same text, so the familiar
  "4 characters per token" rule would understate the configured model by about a
  third.
- **Document Q&A had no explicit bound at all.** It was limited only by the
  product of two constants in unrelated files — `MAX_CONTEXT_PASSAGES` in
  `retrieve.ts` times `MAX_CHARS` in `chunk.ts`, so 19,200 characters — with
  nothing stating it and nothing noticing if either moved. It now has its own
  budget, and drops whole passages rather than cutting one in half, because half
  a passage can be cited as if it were the whole of what a document says.

## The arithmetic

At `claude-opus-5` — $5 per MTok input, $25 per MTok output, from
<https://platform.claude.com/docs/en/about-claude/pricing>, verified 2026-10-01:

```
input bound     16,000 chars / 3.0      = 5,334 tokens
worst output    2,000 tokens (agent)
per attempt     5,334 x $5/M + 2,000 x $25/M = $0.0767
x 2 attempts                                 = $0.1533  <- the ceiling
```

A representative request — half the budget, a 500-token answer, no retry — costs
about **$0.026**. That figure is an estimate and is labelled as one everywhere it
appears. Only the $0.1533 is a bound.

## How that sets the allowances

A monthly price does not yield its sticker value. After Stripe's 2.9% + $0.30:

| Plan | Price | Net | Allowance | Worst case | Typical |
|---|---|---|---|---|---|
| Free | $0 | $0 | 10 | $1.53 | $0.26 |
| Plus | $10 | $9.41 | 30 | $4.60 (49% of net) | $0.78 (8%) |
| Pro | $20 | $19.12 | 60 | $9.20 (48% of net) | $1.55 (8%) |

`MAX_AI_SHARE_OF_NET` in `src/lib/ai/cost.ts` is the dial: half of net revenue is
the most a plan's worst case may consume, leaving the rest for hosting, the
database, object storage and margin. The allowance is then the largest whole
number that fits, rounded down to something a customer can hold in their head.

## The lever not pulled

The allowances are a function of the model. The same budget at a cheaper model:

| Model | Worst case / request | Plus affords | Pro affords |
|---|---|---|---|
| `claude-opus-5` (configured) | $0.1533 | 30 | 62 |
| `claude-opus-5-5` | $0.1227 | 38 | 77 |
| `claude-sonnet-5` | $0.0613 | 76 | 155 |
| `claude-haiku-4-5` | $0.0307 | 153 | 311 |

Switching to Sonnet 5 would roughly two-and-a-half times every allowance at the
same cost. That is a product decision about answer quality, not an optimisation,
so it is recorded here and not applied.

## What is *not* bounded

Stating this plainly, because the point of this document is to not repeat the
original error of calling a partial bound a total one.

- **Hosting, database and storage.** Vercel functions and bandwidth, Neon compute
  and storage, Cloudflare R2 storage and operations. These are real monthly costs
  and none of them is per-request. They are not in the table above and the table
  must not be read as a total cost of service.
- **Aggregate free-tier exposure.** Each free account is bounded at $1.53 of model
  spend a month. A thousand active free accounts all exhausting their allowance is
  $1,530 a month against zero revenue. The per-account bound holds; the aggregate
  scales with signups and is the real financial risk in this design.
- **Document ingestion.** Extraction and chunking are deterministic and make no
  model call, so they cost compute and storage but no tokens. Bounded by the
  upload limits, not by this model.

### Recommended next control

A **global monthly spend breaker**: one counter for the whole deployment, checked
in `reserveAiRequest`, that refuses metered requests once aggregate spend passes a
configured ceiling, degrading everyone to the built-in engine rather than
producing an unbounded invoice. This needs a counter not keyed to a user, so it
needs a small schema change, which is why it is recorded here rather than
implemented alongside the pricing work. Until it exists, the aggregate is bounded
only by the number of accounts.

## The release-month grandfather

Free goes from **25** answers a month to **10**. Every other Free ceiling goes
*up* in the same release — contacts 50 → 100, companies 25 → 50, deals 15 → 25,
opportunities 5 → 10, projects 3 → 5, tasks 100 → 200 — so the AI allowance is
the only thing an existing Free account loses.

A usage counter is keyed by calendar month (`currentPeriod()` → `yyyy-MM`).
Shipping on the 15th would therefore measure requests already made under the old
published ceiling against the new one: an account at 18 would be refused for the
rest of the month, having done nothing but use the product as advertised.

`PRICING_CUTOVER_PERIOD` in `src/lib/plans.ts` names the period in which the new
allowances first apply, and `aiAllowanceFor(plan, period)` returns Free's old
allowance for that one period only. Three properties make it safe rather than
merely generous:

- **Self-expiring.** It is keyed to a period, not an instant, so it lapses when
  the month does. There is no flag to remember, no second deploy to undo it, and
  no window in which an entitlement is removed and then restored.
- **One source of truth.** Enforcement (`reserveAiOrThrow`), the capability check
  (`canUseAi`) and both places that display a gauge all read `aiAllowanceFor`. A
  test fails if any file reads `plan.limits.aiRequestsPerMonth` directly, because
  a displayed ceiling that disagrees with the enforced one is a defect this
  codebase has already shipped once.
- **Free only.** Plus (30) and Pro (60) are above the old Free figure and the
  legacy plans keep their own larger ceilings, so no other plan can be worse off.
  Mutation testing caught that the existing plan set cannot *observe* this guard —
  `max(30, 25)` is 30 either way — so it is asserted against a hypothetical paid
  plan priced below 25 instead.

### What it costs

Per Free account that spends the full old allowance, the extra 15 answers cost
at most **$2.30** at the worst-case per-request ceiling and about **$0.39** at
the typical figure, both from `worstRequestCeilingUsd` / `typicalRequestUsd` on
`claude-opus-5`. The total is 15 × that × *the number of Free accounts that would
otherwise have been refused* — a number only the production usage audit can give,
since it is not every Free account but the few that pass 10 in a month.

One deliberate over-inclusion: a Free account **created during** the cutover
month also gets 25, because the enforcement path reads the period rather than the
account's age. Narrowing it to accounts that predate the release would mean
reading `User.createdAt` on a hot path for a bound already in the low tens of
dollars. The looser rule is the cheaper correct-enough one, and it is stated here
rather than discovered.

### Turning it off

Nothing to do: it expires with the month. The boot line carries
`aiCutover: <period>` so the state is visible, and `instrumentation.ts` warns
once the constant is in the past — that warning is the signal to delete the
constant, `PRE_STRIPE_FREE_AI_ALLOWANCE`, `aiAllowanceFor`'s cutover branch and
this section.

## Legacy allowances

`legacy_pro` and `legacy_lifetime` preserve 1,000 and 2,000 monthly requests
respectively, because those were the entitlements those accounts already held and
reducing them is not something a pricing change should do quietly. At the
configured model, 1,000 requests is a worst case of about **$153 a month** on a
plan nobody is being charged for.

The exposure is presently zero — production has recorded no metered AI usage at
all — but it is a standing liability and the holder of those accounts should
decide whether to keep it. It is deliberately excluded from the affordability
test in `tests/unit/ai-cost-model.test.ts`, which only governs plans that are
sold.
