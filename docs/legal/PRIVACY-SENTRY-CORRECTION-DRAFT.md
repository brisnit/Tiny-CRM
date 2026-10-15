# Privacy notice correction — disclosing Sentry as a subprocessor

**Status: draft for review. Not published.** Separate from the integrations
draft on purpose, and it should stay separate: this is a correction to the
notice that is in force **today**, about something already happening in
production. The integration sections describe something that has not started.
Bundling them would make it impossible to say which change a notice period was
given for.

**This should not wait for the integration release.** It is a live omission in
a published notice — confirmed live, not theoretical: `SENTRY_DSN` is present
in the Production environment — and the integration work could slip for
reasons that have nothing to do with it.

---

## What is wrong

§ 5 of the published privacy notice lists subprocessors: **Anthropic, Stripe,
Resend, Amazon SES.** A reader takes a named list as complete — that is what a
named list is for.

**Sentry is not on it, and Sentry receives production error reports.**
`src/lib/observability.ts` posts to Sentry's Store endpoint whenever the
application captures an exception.

This predates the integration work entirely. I found it while checking whether
a sentence I had drafted for the integration sections was true; it is not
caused by integrations and does not depend on them.

## How bad is it

Two things are true at once, and the correction should say both.

**The design is unusually careful.** Sentry's own SDK is deliberately **not**
used. The SDK's value is automatic instrumentation — breadcrumbs, request
bodies, local variables — which is exactly what must not leave this
deployment, so the envelope is hand-built and posted directly. What is sent is
an explicit allowlist:

> the error's type and message, a stack trace, the request id, the route, the
> operation name, and the ids of the user and workspace.

Message and stack are both scrubbed. Route keeps the path and discards the
query string. Tags must be identifier-shaped or they are replaced by their
length. `AppError.internal` — where this codebase puts diagnostic detail — is
a separate property that is never read into the payload at all.

**And it is still an undisclosed subprocessor.** Careful handling is not
disclosure. Someone exercising a data-subject right, or diligence on us, is
entitled to a complete list, and ours is not complete.

## Proposed wording

Add to the § 5 table, in the same shape as the existing rows:

| Who | What they get | Where |
|---|---|---|
| Sentry | Error reports, assembled from a fixed list of fields: the type and message of a fault, a filtered stack trace, the request identifier, the route path, and the identifiers of the user and workspace. | United States — our Sentry organisation's Data Storage Region |

And beneath it:

> **Error reports are deliberately narrow.** We do not use Sentry's automatic
> instrumentation, which would otherwise capture request bodies, local
> variables and a trail of recent activity. We send a fixed set of fields
> assembled by hand: what went wrong, where in the code, which request, and
> which account. Your records, notes, documents and credentials are not among
> those fields, so they are not attached to a report.
>
> The message and stack trace that are sent are written by the software, not
> by you, and they are filtered before they leave to remove database rows
> quoted by an error, email addresses, and anything shaped like a credential.
> Search terms are removed from the route, because a search term is the name
> of somebody you were looking for. Filtering reduces what an error message
> can disclose; it is a control we apply rather than a guarantee about every
> possible fault.

## What the correction must NOT claim

It must not say error reports cannot contain customer data, and the table row
must not carry a list of absolutes either. Both were drafted and neither
survived being checked — the row originally read "No CRM field values, no note
or document contents, no request bodies, no credentials", which is the same
guarantee in a smaller space.

Scrubbing removes **shapes**: a quoted Prisma row, a PostgreSQL
`Failing row contains (…)` detail, a JSON document quoted by a parse failure,
an email address, a long token. It cannot remove **prose**. A subject line
like "Q4 pricing for Acme" has no token, no address and no structure to
anchor on, so every content rule passes it through — I verified this by
probing the scrubber rather than by reading it, and two of the shapes above
were leaking until this work fixed them.

What keeps correspondence out of error reports is therefore two things, and
the honest claim names both:

1. The allowlist, which means content is never *attached* to a report; and
2. The rule that no code path builds an exception message out of
   correspondence — now enforced by a test
   (`tests/unit/observability-privacy.test.ts`) rather than by habit.

So the notice describes **the control**, not an absolute outcome. That is both
more honest and more durable: the control is something we can keep, where
"never" is something one careless `throw` would break.

## Does this trigger the 30-day clause? — a proposed interpretation, for review

§ 12 promises 30 days' notice for a **material** change. What follows is an
argument for your decision, **not an exemption I have decided applies.** The
notice commitment stands until you say otherwise; nothing here should be read
as having already cleared it.

**The argument for treating this as a correction:** adding a subprocessor that
is already in use does not alter what happens to anyone's data. Sentry has
been receiving these reports throughout. The notice is being made accurate
about the present rather than changed about the future, and a 30-day wait
means 30 further days of an inaccurate notice.

**The argument against, which is not weak:** § 12 says "changes materially",
not "changes what we do". A reader learning for the first time that an
undisclosed third party in another jurisdiction has been receiving data about
their account may reasonably call that material *to them*, whatever its effect
on our systems. The clause exists to protect their expectations, and they
cannot have formed an expectation about a subprocessor they were never told
about. Reading our own omission as the thing that exempts us from our own
notice period is, at minimum, a convenient conclusion to reach — and it is
reached by the party that made the omission.

**My recommendation, offered as that:** give the 30 days. It costs only time,
it is unarguable, and the alternative asks a customer to accept an
interpretation written by us about a mistake of ours. If you decide the
correction reading is right, the decision should be recorded as a decision —
who made it, when, and on what basis — rather than inherited from this draft.

**The effective date is not assumed.** An earlier draft of the customer
notice said this correction took effect "immediately". That was an assumption
standing in for a decision, and it has been removed: the wording now carries
`{SENTRY_CORRECTION_EFFECTIVE_DATE}`, a placeholder separate from the
integration dates, to be set when the question above is answered.

Either way, two things hold:

- **Label it as a correction.** Do not quietly edit the table. A fix that is
  not labelled removes the evidence that anything was wrong.
- **Do not defer it indefinitely** while the integration release settles. If
  the 30 days are given, start them now rather than when integrations are
  ready; the two have nothing to do with each other.

## Also worth checking before this is published

- **Retention.** The proposed row says what Sentry receives but not for how
  long. Sentry's retention is a project setting; it should be read and stated
  rather than assumed.
- **`docs/DPA-DRAFT.md` has the same omission, and one more.** Annex B lists
  Vercel, Neon, Cloudflare R2, Resend, Amazon SES, Anthropic and Stripe —
  and not Sentry. The privacy notice names all seven of those too, so the two
  documents are consistent with each other and both wrong in the same place.
  Correct them in one pass.

  Annex B also carries the sentence *"Telemetry carries an allowlist of fields
  and never record contents, note text, prompts, passwords or tokens."* The
  allowlist half is true and verified. The **"never record contents"** half is
  the same overclaim this draft declines to make: it is true of everything
  attached to a report and not provable of prose someone writes into an
  exception message. It should be reworded to describe the control, exactly as
  proposed above.

- ~~Sentry's region.~~ **Confirmed: United States**, read from the Sentry
  organisation's Data Storage Region setting and written into both this
  document and the DPA Annex B row. They must not disagree, and they now do
  not.
- ~~Whether `SENTRY_DSN` is actually set in production.~~ **Confirmed
  present.** `vercel env ls production` lists `SENTRY_DSN` scoped to
  Production, created 36 days ago. Presence only — Vercel reports every value
  as "Encrypted" and no DSN was read or printed. So the adapter is installed
  (`if (env.sentryDsn) return new SentryAdapter(...)`) and reports are being
  sent today. The omission is live, not theoretical, and the row should be
  written in the present tense rather than conditionally.
