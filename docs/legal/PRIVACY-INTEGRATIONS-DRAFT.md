# Privacy notice — proposed additions for email and calendar import

**Status: draft for review. Not published.** Nothing in
`src/app/(marketing)/privacy/page.tsx` has been changed, the effective date is
untouched, and no notice period is shortened. This file is the proposal; the
decision to publish it, and when, is yours.

**`INTEGRATIONS_EFFECTIVE_ON` is a placeholder and stays one.** No date is
written anywhere in this file or in the email draft — only the named constant
and `{EFFECTIVE_DATE}`. The date is not mine to choose: it is fixed when you
approve the publication and email date together, because the two are the same
decision (the 30 days run from the email, so a publication date without a send
date means nothing). Until then, every reference is a placeholder, and
`src/lib/legal.ts` is unchanged.

**Availability claims are scoped to customers throughout.** See the note under
"Two effective dates" for why the broader phrasing would be untrue.

Every statement below was checked against the implementation rather than
against the product copy. Two existing claims did not survive that check and
are listed under **Corrections required** — one of them is a privacy promise
currently shown to customers that the code does not keep.

---

## Corrections required before any of this is published

### 1. The Settings page promises sharing that does not exist

`src/app/(app)/settings/integrations/page.tsx` currently tells every customer:

> **What you import stays yours.** Imported mail and meetings are visible to
> you alone, even to people who share this workspace. **They become visible to
> the workspace only when you attach one to a contact, company, deal or project
> yourself.**

The bolded sentence is false in both directions:

- **Attaching does not share.** The importer writes `contactId` at creation
  when it finds one unambiguous matching contact, and never touches
  `visibility`. An imported message auto-linked to a contact is still private
  to the person whose mailbox it came from.
- **There is no way to share at all.** Nothing in the application writes
  `visibility: "workspace"`, `sharedAt` or `sharedById` on an imported row.
  The columns exist; the action does not.

The privacy effect is conservative — items stay *more* private than promised,
not less — but the sentence describes a control a customer does not have, and
a notice must not repeat it. Proposed replacement for that sentence:

> Imported mail and meetings are visible to you alone, and there is currently
> no way to share one with your workspace. Attaching one to a contact does not
> change who can see it.

### 2. A stale comment in `src/lib/ai/imported-data.ts`

It says "Disconnecting a mailbox nulls `integrationId`". It does not —
`onDelete: SetNull` fires only when the `Integration` row is deleted, and a
disconnect keeps the row. The conclusion drawn from it (key the AI exclusion on
`source`, not `integrationId`) is right and is *more* robust than the reasoning
given, so no behaviour changes. The comment should be corrected so nobody
relies on it later.

---

## § 2 — What is collected

Add, under "What you give us", after "Your CRM content":

> **Email and calendar you choose to connect.** If you connect a mailbox or
> calendar, Tiny CRM reads and stores:
>
> - **For each message:** the provider's message and conversation identifiers,
>   the subject line, a short preview of the body, the sender's address and
>   display name, the recipients' addresses and display names, the time it was
>   received, and whether it was read.
> - **For each meeting:** the provider's event identifier, the title, a short
>   preview of the description, the location, the online-meeting link, the
>   start and end times, and whether it is an all-day event.
>
> **Message bodies are not stored.** Only the preview the provider returns —
> typically the first couple of lines. Attachments are not read or stored.
> Meeting attendee lists are read in order to match a meeting to an existing
> contact, and are not stored.

*Verified:* the `$select` sent to Microsoft Graph requests exactly
`id, conversationId, subject, bodyPreview, receivedDateTime, isRead, from,
toRecipients` for mail and
`id, iCalUId, subject, bodyPreview, isAllDay, isCancelled, start, end,
location, onlineMeeting, onlineMeetingUrl, organizer, attendees` for calendar.
The importer writes `subject`, `snippet`, `fromEmail`, `fromName`, `toJson`,
`direction`, `sentAt`, `isRead`, `threadId`, `externalId` for mail, and
`title`, `description`, `location`, `meetingUrl`, `startAt`, `endAt`,
`allDay`, `externalId` for meetings. `iCalUId`, `isCancelled` and the attendee
list are requested and **not** persisted; attendees reach only the contact
matcher. No full body and no attachment is ever requested.

---

## § 4 — How information is used

Add:

> **To show your correspondence beside the records it concerns.** A connected
> mailbox or calendar is read so that messages and meetings appear against the
> contact they involve. Tiny CRM matches an item to a contact only when exactly
> one contact in your workspace has a matching email address; otherwise the
> item is left unattached for you to file by hand.

*Verified:* `associateContact` links only on an exact, unambiguous,
accessible single match, and records a reason when it declines.

---

## § 5 — Where data goes

Add, before the subprocessor table:

> **Microsoft, when you connect Outlook.** Microsoft is your own provider, not
> a company we pass your data to: the flow is inbound. When you connect, you
> authorise Tiny CRM through Microsoft's own consent screen, and Tiny CRM then
> reads from Microsoft Graph using that authorisation. **The access is
> read-only.** Tiny CRM requests permission to read mail and read calendars and
> requests no permission to send, reply, create, modify or delete anything in
> your mailbox or calendar, and holds no capability to do so.
>
> Your correspondence is not sent to Anthropic — see § 6. Error reports used
> to diagnose faults are assembled from a fixed list of fields — what went
> wrong, where in the code, which request, which account — so message and
> meeting contents are not attached to them, and the text that is sent is
> filtered to remove quoted database rows, addresses and credentials.

*Verified:* the Outlook providers request `Mail.Read`, `Calendars.Read`,
`User.Read`, `offline_access`, `openid`, `profile`, `email` and nothing
further. No send or write scope is requested anywhere, and no code path posts
to a mailbox or calendar endpoint.

---

## § 6 — Artificial intelligence

Add as a further bullet:

> **Imported mail and meetings are never sent to a model provider**, whatever a
> workspace's AI setting is. Connecting a mailbox lets Tiny CRM show your
> correspondence inside the CRM; it is not consent to send that correspondence
> to Anthropic, and those are treated as separate decisions. Imported items are
> excluded from the daily brief, from answers, from recommendations and from
> every other feature that leaves our servers. Demonstration data seeded into a
> new workspace is not imported correspondence and is not covered by this
> exclusion.

*Verified:* `EXCLUDE_IMPORTED` keys on `source = "imported"`, written once at
import and never changed, and is spread into both `aiContextFor` and
`recommendations` — the two call sites that previously pulled subjects and
snippets into a provider prompt.

---

## § 7 — Security

Add:

> **Access tokens are encrypted before they are stored**, with a key derived
> separately from the keys used for anything else, and are never written to
> logs. If a stored token becomes unreadable, the connection stops importing,
> destroys the unreadable token and asks you to reconnect rather than retrying.

*Verified:* AES-256-GCM via `src/lib/crypto.ts` under the purpose
`integration-credentials`, with its own scrypt salt. On a decryption failure
`accessTokenFor` sets the connection to `reauth_required`, nulls the stored
credential, records a customer-facing message, and the worker now stands the
chain down instead of retrying.

---

## § 8 — Retention

Add:

> **Disconnecting a mailbox or calendar.** Disconnecting immediately destroys
> the stored access token, so no further import is possible. You are asked what
> to do with what has already been imported:
>
> - **Keep it** (the default): imported messages and meetings stay in your CRM,
>   still visible only to you, and remain attached to any record they were
>   filed against.
> - **Delete it:** every message and meeting imported through that connection
>   is deleted. Items from other sources are unaffected.
>
> Deleting your account or workspace removes imported items with everything
> else, as described above.

*Verified:* `disconnectConnection` destroys `credentials` and
`tokenExpiresAt`, bumps the generation so in-flight work stands down, and
deletes imported rows only when `keepImported` is false. Nothing re-opens a
disconnected connection; recovery and retry both refuse any connection that is
not `connected`.

---

## § 9 — Your choices

Add:

> **Connecting is optional and reversible.** Nothing is imported unless you
> connect a mailbox or calendar yourself, and disconnecting is available at any
> time in Settings → Integrations.

---

## Does this trigger the 30-day clause?

§ 12 reads, verbatim:

> If this notice changes materially, we will give at least **30 days' notice by
> email to your account address**. Changes required sooner by law may take
> effect sooner, with notice as appropriate.

The trigger is **materiality**, not any change at all. My reading — and it is a
reading, not a legal opinion:

**Yes, these additions are material, and the clause applies.** They add a new
category of personal data (the contents and metadata of correspondence,
including personal data about third parties who are not Tiny CRM users), a new
source, a new purpose, and a new provider relationship. If "material" means
anything, it means that. Several of the additions are favourable to the
customer — the AI exclusion, the read-only scope, the privacy default — but a
clause about material change does not have an exception for good news, and
publishing a narrowing-of-rights and an expansion-of-collection together under
the heading "clarifications" would be the wrong call.

Two things follow:

1. **The 30 days run before the change takes effect, not before it is
   published.** The clause promises notice, so the sequence is: publish the
   updated notice carrying a *future* effective date, email every account
   address on the day it is published, wait at least 30 days, and only then
   does it take effect. The currently effective notice stays available and
   authoritative throughout that window — the integration sections are visibly
   pending, not live.
2. **The canary is a judgement about your own data.** The 30 days govern what
   customers are told. The canary imports Artifact Digital's own mailbox into
   Artifact Digital's own workspace, where you are the controller of that
   correspondence — no customer's data is involved and no customer is relying
   on the notice for it. That correspondence does contain third parties'
   personal data, so it is not nothing, but it is yours to weigh. What is not
   a judgement call: **no customer may connect a mailbox until the updated
   notice has taken effect**, which is what the per-workspace `integrations`
   flag staying off is for.

### An approach that was considered and rejected

An undated addendum reading "takes effect when email and calendar connections
become available to customers" would avoid committing to a date the release
might miss. **It is not acceptable and is not proposed.** § 12 promises *"at
least 30 days' notice by email to your account address"* — a notice whose
effective date is a condition rather than a date gives nobody 30 days of
anything, cannot be measured against the promise, and leaves a customer unable
to answer "from when?". An undated addendum is not a substitute for the
promised email notice and must not be treated as one.

The right shape is the dull one: pick a date, publish with it, send the email
that day, and if the release slips, the notice simply takes effect before the
feature appears. A notice in force ahead of the capability costs nothing. A
capability ahead of its notice is the thing that cannot be undone.

## Two effective dates, deliberately

The notice needs to express that the current text governs today and the
integration text governs from a named future date. `LEGAL_EFFECTIVE_ON` in
`src/lib/legal.ts` is a single constant that drives the page header, so this
needs a second one rather than a change to the first:

- `LEGAL_EFFECTIVE_ON` — **unchanged.** Still the date the currently effective
  notice took force. Nothing about today's obligations moves.
- `INTEGRATIONS_EFFECTIVE_ON` — new, set to a date **at least 31 days after
  the day the email goes out**, giving a clear day's margin over the promised
  minimum rather than landing exactly on it.

Each integration section carries its own dated marker, so a customer reading
the page before that date sees both what governs now and what will govern
later:

> *This section takes effect on {INTEGRATIONS_EFFECTIVE_ON}. Until then,
> email and calendar connections are not available to customers.*

**Why that sentence and not a broader one.** An earlier version of this marker
added "and nothing described here is collected". That is a blanket claim about
the whole product, and it is not one we can make: Artifact Digital's own canary
mailbox has already been imported — 320 real messages and 16 real meetings —
during development. That is our own correspondence, in our own workspace, with
us as the controller, and no customer's data is involved. It is still
collection of the kind this section describes, so a public notice must not say
it has not happened.

What is true, verifiable and sufficient is the narrower statement: **customers
cannot connect anything.** That is enforced by the `integrations` flag, which
is off globally and will be enabled for one workspace at a time. Scope every
public availability claim to customers for this reason, and resist the
temptation to make the broader one because it reads better.

That marker is removable in one commit on the day, and the sections stop being
conditional without any other edit.

## A separate gap this turned up, which is not mine to close

While checking the sentence "your correspondence is not sent to any of the
subprocessors listed below", I found that claim could not be made safely —
because the list is not complete.

**Sentry is a live subprocessor and does not appear in the § 5 table.** It
receives error reports from production (`src/lib/observability.ts`, the
`SentryAdapter`), and the table lists only Anthropic, Stripe, Resend and
Amazon SES. This predates the integration work entirely and is not caused by
it.

Two things to say about it honestly:

- **The data reaching Sentry is scrubbed.** `scrubMessage`, `scrubStack` and
  `scrubRoute` strip passwords, tokens, API keys and request bodies, and
  nothing in the integration code paths logs a subject, a snippet, an address
  or a token — the importer logs counts, and the canary verifier is written
  to print none of it. So the narrower sentence now proposed above is true.
- **The omission is still a defect in the published notice**, and arguably
  material on its own: a named subprocessor list that omits a subprocessor is
  worse than no list, because a reader takes it as complete.

I have not touched § 5's table. Adding Sentry is a separate decision about the
*current* notice, with its own materiality question and possibly its own
30-day clock, and bundling it into the integration release would blur which
change the notice period was given for. Flagging it rather than fixing it.

## What is not covered here

- Google and Gmail. Both are built but dark, and Gmail's restricted scopes need
  Google's own verification and an annual security assessment before anyone
  outside our organisation can grant them. Their wording should be added when
  they are actually offered, not pre-emptively.
- Any Data Processing Addendum or subprocessor-notification obligation that the
  terms of service may impose separately. I have not read the terms against
  this; it should be checked before publication.
- Whether the Microsoft app registration needs a privacy-statement URL for a
  multi-tenant listing. It is single-tenant today, so this does not arise yet.
