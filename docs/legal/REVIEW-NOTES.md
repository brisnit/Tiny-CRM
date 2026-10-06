# Internal review notes — privacy notice and terms

**Internal. Not page content.** Nothing in this file is rendered on `/privacy` or
`/terms`. It records what the 5 October 2026 review copy left open, plus what
checking that copy against the repository turned up.

Status: both pages are **routed and linked**, carry an **"Effective date"** line
taken from `LEGAL_EFFECTIVE_ON`, signup requires accepting the terms, and PR #31
is **draft** — nothing is merged or deployed.

**The draft banner has been removed from both pages.** It said they "should not be
published", which would have been false on a published page, and a banner is the
wrong place for the caveats anyway. The pages claim no legal review, no
certification and no compliance with any jurisdiction; the factual limitations —
no data processing agreement, no promise of data residency, retention as
implemented, and no tax collected — stay in the customer-facing text where a
reader meets them in context. The unresolved *operational* questions stay here,
internal, and render nowhere.

## What was approved and is now written into the pages

| Decision | Where |
|---|---|
| Liability cap — the greater of $100 USD or fees paid in the preceding 12 months, with exceptions for fraud and willful misconduct, and mandatory statutory rights preserved | terms §9 |
| California law, San Diego County courts, mandatory protections and non-restrictable claims preserved | terms §11; cross-referenced from privacy §12 |
| Breach notification without undue delay, subject to applicable legal requirements, by email, with staged information permitted | privacy §7 |
| Controller / processor split | privacy §1 |
| Privacy-request handling, including routing requests about a customer's contacts to that customer | privacy §9 |
| Factual cookie description — session plus CSRF, no advertising or analytics | privacy §3 |

All nine previous counsel placeholders have been removed, because revised wording
now occupies each position. Internal drafting commentary has been taken out of the
customer-facing text; what remains of it lives in code comments and in this file.

## Still unresolved — do not treat as settled

### 1. Tax registration and collection obligations

The pages state current behaviour only: no tax is added at checkout, and if
collection begins it will be shown before purchase. **That is not a determination
that no tax is owed.** The Stripe account has automatic tax enabled for
Dashboard-created transactions but holds **no California registration**, and the
application's Checkout Sessions enable neither automatic tax nor any tax rate.
Registration and collection obligations, and their thresholds, are unresolved.

### 2. Data processing agreement

None is offered, and the page says so. The review copy's caution stands: **asking a
customer to email us is not a substitute for an agreement required by law.** If a
customer's use requires processing terms, the current answer is that we may not be
able to support it.

### 3. International-transfer safeguards

None has been established. The page describes confirmed provider locations, states
that processing may occur outside the customer's country, and explicitly does not
promise data residency. No transfer mechanism — SCCs, DPF reliance or otherwise —
is in place or claimed.

### 4. The liability cap is not a guarantee of enforceability

The approved cap is written as approved. Whether it is enforceable in any given
forum is untested, and no broad customer indemnity and no separate exclusion of
consequential damages were added.

### 5. Privacy requests need a real fulfilment process

The absence of a self-service closure button does not remove deletion obligations.
Still to decide: who answers `privacy@tinycrm.biz`, within what time, how a request
touching a **shared workspace** is handled so one person's deletion does not remove
another's data, and what happens to **retained audit records** that the current
implementation never purges.

### 6. Retention facts come from the implementation, not an audit

The retention section was written from the code and from provider documentation.
The provider's published 30-day backup retention is **not** treated as a guarantee
that every copy of a record is erased within 30 days, and the page says so.

## The contradiction found earlier is now resolved

The earlier note recorded that terms §1 said &ldquo;By creating an account you
accept them&rdquo; while the signup flow presented neither document. **Fixed**, on
authorisation:

- An unchecked, `required` checkbox at signup: *&ldquo;I agree to the Terms of
  Service and acknowledge the Privacy Notice&rdquo;*, each phrase linking to its
  page, opened in a new tab so a half-filled form is not lost.
- **Server-side enforcement** in `signUpSchema`. The checkbox's `required`
  attribute stops an ordinary submit, but a client can be made to post anything,
  so the control is the action: `acceptedTerms` must parse as a boolean and refine
  to exactly `true`. Omitted, `false`, `null` and the string `"on"` are all
  refused, and refusal happens before the duplicate-email branch, so no account
  row is created either way.
- **Recording**: `User.termsAcceptedVersion` and `User.termsAcceptedAt`, set from
  `TERMS_VERSION` — the same constant the pages display as their effective date,
  so a stored acceptance can always be matched to the text that was shown.

Verified in a real browser: the box is present, unchecked, and `required`; its
links resolve to `/terms` and `/privacy`; submitting with it clear creates no
account and stays on `/signup`; checking it creates the account with version
`2026-10-05` and a timestamp.

## Claims in the review copy that were checked and hold

Each was verified against the repository before being written in:

- "Files can be downloaded individually" — `src/app/api/files/[id]/download/route.ts`
  exists, with preview and download deliberately separate capabilities.
- The 16,000-character per-request AI cap — `MAX_PROMPT_CHARS = 16_000` in
  `src/lib/ai/cost.ts`.
- A "Private model only" mode that behaves like Disabled without a zero-retention
  provider — `AI_MODES` includes `private`, and `aiPermission` refuses it when the
  configured provider lacks enterprise controls.
- A cross-workspace request where any workspace has AI disabled is answered locally
  — `crm-agent.ts` requires `permissions.every((p) => p.mayTransmitContent)`.
- Export shape: six CSV exports, 50,000-row cap, trashed records excluded, notes,
  activity, files, tags and custom values absent.
- Retention: 365 days after acknowledgement for security alerts, trash never
  emptied, audit records never purged, 7-day workspace-deletion grace, 6-hour
  point-in-time recovery, 30-day provider backup retention.
- Seats of 1 / 3 / 10 for Free / Plus / Pro, and the October 2026 Free allowance of
  25 against a standing 10.

The plans table, the seat figures, the cutover month and the legacy Free allowance
are all **generated from `src/lib/plans.ts`** rather than typed into the page, so
the page cannot quote a figure the product does not enforce.

## Remaining publication questions

1. ~~Set an effective date~~ — done. `LEGAL_EFFECTIVE_ON = "2026-10-05"` in
   `src/lib/legal.ts` is both the published effective date and the version recorded
   against each acceptance. **If publication slips past 5 October, change that one
   line** — not because a version dated earlier would falsify an acceptance
   record, but because the page must not display an effective date it did not
   have. The version string identifies *which text* was agreed; `termsAcceptedAt`
   records *when*. Only the second is a timestamp of consent.
2. ~~Present the terms at signup~~ — done, see above.
3. ~~Restore the routes and footer links~~ — done.
4. **Decide items 1–5 under *Still unresolved*, or publish with them open** and
   accept that posture deliberately. This is the only one left before merge.

### Deployment order — the migration must go first

`User.termsAcceptedVersion` and `User.termsAcceptedAt` are new columns, so this
release is not a pure code deploy. Both columns are **nullable and additive**,
which is what makes the safe order possible:

1. **Apply the migration to production first**, from a machine with the owner URL:
   `npm run db:use-postgres && npx prisma migrate deploy`. The PostgreSQL copy is
   `prisma/migrations-postgres/20261005120100_terms_acceptance`.
2. **Then merge and deploy.**

That order is not a preference. `scripts/deploy-gate.mjs` compares the migrations
the commit ships in `prisma/migrations-postgres` against the rows in
`public."_prisma_migrations"` and **fails the build** if one is missing — so
merging first would block the deploy rather than half-apply it. And applying first
is harmless: the build currently serving traffic selects neither column.

There is **no backfill**. Existing accounts keep `NULL`, which honestly means
&ldquo;no acceptance was recorded&rdquo; — not &ldquo;refused&rdquo;. Inventing a
timestamp for an account that never saw the checkbox would put a false record in
the one place a dispute would look.
