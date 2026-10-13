# Privacy notice correction — disclosing Sentry as a subprocessor

**Status: draft for review. Not published.** Separate from the integrations
draft on purpose, and it should stay separate: this is a correction to the
notice that is in force **today**, about something already happening in
production. The integration sections describe something that has not started.
Bundling them would make it impossible to say which change a notice period was
given for.

**This should not wait for the integration release.** It is a live omission in
a published notice, and the integration work could slip for reasons that have
nothing to do with it.

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
| Sentry | Error reports: the type and message of a fault, a scrubbed stack trace, the request id, the route path, and the user and workspace ids. No CRM field values, no note or document contents, no request bodies, no credentials. | United States |

And beneath it:

> **Error reports are deliberately narrow.** We do not use Sentry's automatic
> instrumentation, which would otherwise capture request bodies, local
> variables and a trail of recent activity. We send a fixed set of fields
> assembled by hand: what went wrong, where in the code, which request, and
> which account. Messages and stack traces are filtered before they are sent
> to remove quoted database rows, addresses and credentials. Search terms are
> removed from the route before it leaves, because a search term is the name
> of somebody you were looking for.

## What the correction must NOT claim

It must not say error reports cannot contain customer data. I tried to write
that sentence and it did not survive being checked.

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

## Does this trigger the 30-day clause?

§ 12 promises 30 days' notice for a **material** change. My reading, and it is
a reading:

**Adding a subprocessor that is already in use is a correction, not a change.**
Nothing about what happens to anyone's data is being altered — Sentry has been
receiving these reports throughout. The notice is being made accurate about
the present, not changed about the future. A 30-day wait would mean 30 further
days of an inaccurate notice, which serves nobody.

So: publish it when approved, and say plainly in the changelog entry that it is
a correction of an omission rather than a new disclosure. **Do not** quietly
edit the table — a correction that is not labelled as one is worse than the
omission, because it removes the evidence that anything was wrong.

If you would rather treat it as material and give the 30 days anyway, that is
a defensible choice and costs only time. What is not defensible is deferring
it indefinitely while the integration release settles.

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

- **Whether `SENTRY_DSN` is actually set in production.** The adapter is
  installed only when it is configured — `if (env.sentryDsn) return new
  SentryAdapter(...)`, with a fallback to logs otherwise. I have **not** read
  production's environment, so I cannot say from here whether reports are
  being sent today. Two reasons to think they are: a production Sentry issue
  (TINY-CRM-8, release 473d353) was investigated earlier in this work, which
  is hard to explain if nothing is being sent. Confirm it from the Vercel
  environment rather than from that inference before publishing, and if it is
  unset, the row should read "when error reporting is enabled" instead.
