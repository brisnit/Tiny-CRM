# Legal page drafts — held back from the pricing release

These are the real `/privacy` and `/terms` pages, intact, deliberately **not
routed**. The pricing release ships Free / Plus / Pro without them.

## Why they are here and not under `src/app/`

Both pages render a banner that says, to every visitor:

> **Draft — not yet legally reviewed.** … This page should not be published, and
> must not be used to satisfy a payment processor's requirements, until those are
> filled in and a lawyer has reviewed the result.

Publishing a page that says it should not be published, linked from the front
page, on the same deploy that starts advertising paid plans, is not a thing to do
by accident. So the routes are out of this release and the drafts are kept where
they cannot be served.

Thirteen gap markers remain — nine on privacy, four on terms. Two are business
decisions (whether a DPA is offered; the suspension notice period and appeal
route), one is a fact still to confirm (what the database provider retains beyond
the 6-hour recovery window), and ten need counsel.

## This blocks live billing, not just the pages

Stripe wants a reachable privacy policy and terms of service before a live
Customer Portal can be launched. That requirement is the reason the footer linked
them in the first place. **Confirm it when setting the live portal up**, because
if it holds, these pages have to ship before billing can go live — which makes
restoring them a prerequisite of step 4 in the release plan, not a follow-up.

Nothing in the test-mode flow needs them; the sandbox portal was configured and
verified without them.

## What is accurate in them, and what is not

Everything describing how the software behaves was read from the code and is
accurate as of this branch, including:

- the six CSV exports, their 50,000-row cap, and the fact that trashed records,
  notes, activity, files, tags and custom field values are excluded;
- retention as implemented — the daily sweep, security alerts deleted 365 days
  after acknowledgement, audit records never deleted, trash never emptied;
- the 6-hour point-in-time recovery window, stated as a recovery window and
  explicitly not as a deletion guarantee, and the absence of any independent copy;
- that account closure does not exist in the product;
- the subprocessor table, with Vercel, Neon, Cloudflare R2, Resend, Amazon SES,
  Anthropic and Stripe, and the regions established for each;
- cancellation giving no refund for unused time, downgrade credits versus upgrade
  charges appearing on the next invoice, and 30 days' notice by email.

`terms-page.tsx` reads prices and limits from `src/lib/plans.ts` rather than
hard-coding them, which is why it cannot quote a figure the product does not
enforce. That binding is preserved — do not convert these to Markdown, or it is
lost and the pages can drift from the product the way the marketing page once did.

## Restoring them

Three steps, and the drafts are otherwise unmodified:

```bash
mkdir -p "src/app/(marketing)/privacy" "src/app/(marketing)/terms"
git mv docs/legal/privacy-page.tsx "src/app/(marketing)/privacy/page.tsx"
git mv docs/legal/terms-page.tsx    "src/app/(marketing)/terms/page.tsx"
git mv docs/legal/legal.tsx          src/components/marketing/legal.tsx
```

Then, in each restored page, change `from "./legal"` back to
`from "@/components/marketing/legal"` — the one edit made when they were moved —
and re-add the two footer links in `src/app/(marketing)/page.tsx`, where a comment
marks the place they were removed from.

`tests/unit/ai-cutover-allowance.test.ts` keeps
`src/app/(marketing)/terms/page.tsx` in the list of files permitted to read
`plan.limits.aiRequestsPerMonth` directly. That entry is unused while the page
lives here, and correct again the moment it goes back; it was left in place
deliberately rather than removed and forgotten.

## Related

- `docs/COMMERCIAL-POLICIES.md` — the approved commercial decisions, the evidence
  for each, and what is still for counsel.
- `docs/DPA-DRAFT.md` — not promised to anyone, and section 7 explains why it
  cannot be until account closure exists.
- `docs/PRIVACY-NOTICE-DRAFT.md` — the earlier prose draft these pages superseded.
