# DPA corrections — Annex B subprocessors and the telemetry sentence

**Status: draft for review. Not applied.** `docs/DPA-DRAFT.md` is unchanged.
This is the matching pair to `PRIVACY-SENTRY-CORRECTION-DRAFT.md`: the same
omission appears in both documents, and they should be corrected together so
the two never disagree about who receives what.

Two corrections, one of which is an omission and one of which is an overclaim.

---

## Correction 1 — Annex B omits Sentry

Annex B currently lists seven subprocessors: Vercel, Neon, Cloudflare R2,
Resend, Amazon SES, Anthropic, Stripe. The privacy notice names the same
seven. Both omit Sentry, which receives production error reports.

**Confirmed live, not theoretical:** `SENTRY_DSN` is present in the Production
environment (created 36 days ago, verified by presence — no value read or
printed), and `getAdapter()` installs the Sentry adapter whenever it is set.

### Proposed row

| Subprocessor | Purpose | Where the data is stored | Basis |
|---|---|---|---|
| Sentry | Error reporting, assembled from a fixed list of fields: the type and message of a fault, a filtered stack trace, the request identifier, the route path, and the identifiers of the user and workspace | United States — our Sentry organisation's Data Storage Region | Verified from code (`src/lib/observability.ts`, `SentryAdapter`) and from `SENTRY_DSN` being present in the Production environment |

The location is now **confirmed**, not inferred: read from the Sentry
organisation's Data Storage Region setting. Both this row and the privacy
notice's § 5 row carry the same value, which was the condition for writing a
country at all — an earlier draft asserted "United States" before anyone had
checked, and that assertion was withdrawn until it could be.

### Also unread

- **Retention.** How long Sentry keeps an event is a plan and project setting.
  Annex B does not state retention for any subprocessor, so this is consistent
  as it stands — but if retention is added for one, it should be added for all.
- **Whether a DPA with Sentry is in place.** Annex B's "Basis" column records
  how we know the subprocessor is used, not whether a contract exists. Worth
  separating if this document ever becomes binding.

---

## Correction 2 — the telemetry sentence overclaims

Annex B closes with:

> Transactional email carries a name, an email address and a link — never CRM
> record contents. Telemetry carries an allowlist of fields and never record
> contents, note text, prompts, passwords or tokens.

The first sentence is fine. The second is half right, and the half that is
wrong is the half that matters.

**True and verified:** telemetry carries an allowlist. The payload is built
field by field — type, message, stack, request id, route, operation, user id,
workspace id, release, environment, tags — and nothing else is attached. There
is no Sentry SDK, so there are no breadcrumbs, no local variables and no
request bodies. Tags must be identifier-shaped or they are replaced by their
length. `AppError.internal`, where this codebase puts diagnostic detail, is
never read into the payload.

**Not provable: "never record contents".** Scrubbing removes *shapes* — a
quoted Prisma row, a PostgreSQL `Failing row contains (…)` detail, a JSON
document quoted by a parse failure, an email address, a long token. It cannot
remove *prose*. An exception message reading `could not import message: Q4
pricing for Acme` contains no token, no address and no structure to anchor on,
and every content rule passes it through. This was established by probing the
scrubber with real message shapes, not by reading it — and two of those shapes
were leaking until that probe found them.

### Proposed replacement

> Telemetry carries an allowlist of fields — what went wrong, where in the
> code, which request, and which account — assembled explicitly rather than
> captured automatically, so record contents, note text, prompts, passwords
> and tokens are not attached to it. The message and stack trace that are sent
> are filtered before they leave to remove database rows quoted by an error,
> email addresses, and anything shaped like a credential.

This describes the control rather than asserting an outcome. It is weaker as a
sentence and stronger as a commitment: the control is something we keep, where
"never" is something a single careless `throw` would break.

### What backs the replacement

- The allowlist: `buildPayload` in `src/lib/observability.ts`.
- The filtering: `QUOTED_DATA` and `stripSensitive`, applied to both message
  and stack.
- The residual, written down rather than hidden:
  `tests/unit/observability-privacy.test.ts` asserts that prose in an
  exception message **survives** scrubbing, so nobody reads the passing tests
  and concludes otherwise.
- What actually keeps correspondence out: a guard in the same file asserting
  that no code path builds an exception message out of a subject, snippet,
  title or address.

---

## Sequencing

These are corrections to a document that describes current processing, exactly
like the privacy-notice correction. They should move together with it and
should not wait for the integration release.

Whether the 30-day commitment in the privacy notice applies to a correction of
this kind is **a question for you, not a conclusion in this draft** — see
`PRIVACY-SENTRY-CORRECTION-DRAFT.md`, which sets out the argument both ways
and recommends giving the 30 days. Note that `DPA-DRAFT.md` is itself a draft
and has not been executed with anyone, so its own change control may be a
different question again.
