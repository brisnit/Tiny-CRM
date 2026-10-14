# Tiny CRM — proposed privacy wording

**Nothing here is published or sent.** The dates that appear — 20 October
2026 for publication and sending, 23 November 2026 for the integration
provisions — are **proposed and pending approval**.

No commentary, no evidence notes, no rationale — this is the text itself. The
reasoning behind each passage is in the other drafts under `docs/legal/`.

---

# Privacy notice — new and changed sections

## § 2. What is collected — addition

**Email and calendar you choose to connect.** If you connect a mailbox or
calendar, Tiny CRM reads and stores:

- **For each message:** the provider's message and conversation identifiers,
  the subject line, a short preview of the body, the sender's address and
  display name, the recipients' addresses and display names, the time it was
  received, and whether it was read.
- **For each meeting:** the provider's event identifier, the title, a short
  preview of the description, the location, the online-meeting link, the start
  and end times, and whether it is an all-day event.

Message bodies are not stored. Only the preview the provider returns —
typically the first couple of lines. Attachments are not read or stored.
Meeting attendee lists are read in order to match a meeting to an existing
contact, and are not stored.

## § 4. How information is used — addition

**To show your correspondence beside the records it concerns.** A connected
mailbox or calendar is read so that messages and meetings appear against the
contact they involve. Tiny CRM matches an item to a contact only when exactly
one contact in your workspace has a matching email address. Anything it cannot
match that way is still imported and still private to you; it simply is not
shown against a record.

## § 5. Where data goes — addition

**Microsoft, when you connect Outlook.** Connecting sends you to Microsoft to
sign in and approve the access, and Tiny CRM then exchanges and periodically
refreshes an access token with Microsoft's servers. Each time it reads your
mailbox or calendar it makes a request to Microsoft Graph carrying that token
and the terms of the request — the date range it is asking about and the list
of fields it wants back.

So traffic does flow to Microsoft, and it is worth being plain about what it
is: requests for your own data, sent to your own provider, using an
authorisation you granted. Those requests do not carry your Tiny CRM records,
notes, files or contacts. **The access is read-only.** Tiny CRM asks for
permission to read mail and read calendars; it asks for no permission to send,
reply, create, modify or delete anything in your mailbox or calendar, and
holds no ability to do so.

## § 5. Where data goes — new subprocessor row

The live page's third column is headed **"Reported location or routing"**,
and the row below is written to drop into it unchanged. Two earlier drafts
headed it "Where" and "Location", both of which say more than was checked.

| Service | Purpose | Reported location or routing |
| --- | --- | --- |
| Sentry | Error reports, assembled from a fixed list of fields: the type and message of a fault, a filtered stack trace, the request identifier, the route path, and the identifiers of the user and workspace. | United States — our Sentry organisation's Data Storage Region |

**Error reports are deliberately narrow.** We do not use Sentry's automatic
instrumentation, which would otherwise capture request bodies, local variables
and a trail of recent activity. We send a fixed set of fields assembled by
hand: what went wrong, where in the code, which request, and which account.
Your records, notes, documents and credentials are not among those fields, so
they are not attached to a report.

The message and stack trace that are sent are written by the software, not by
you, and they are filtered before they leave to remove database rows quoted by
an error, email addresses, and anything shaped like a credential. Search terms
are removed from the route, because a search term is the name of somebody you
were looking for. Filtering reduces what an error message can disclose; it is
a control we apply rather than a guarantee about every possible fault.

## § 6. Artificial intelligence — addition

**Imported mail and meetings are never included in a request sent to an AI
model provider**, whatever a workspace's AI setting is. Connecting a mailbox
lets Tiny CRM show your correspondence inside the CRM; it is not consent to
send that correspondence to Anthropic, and those are treated as separate
decisions. Imported items are excluded from the daily brief, from answers, and
from the recommendations the service generates — the three features that build
a request to a model provider. Demonstration data seeded into a new workspace
is not imported correspondence and is not covered by this exclusion.

## § 7. Security — addition

**The access token and the refresh token are both encrypted before they are
stored.** They are held together as a single encrypted record, with a key
derived separately from the keys used for anything else, and neither is
written to logs. If that stored record becomes unreadable, the connection
stops importing, destroys it, and asks you to reconnect rather than
retrying.

## § 8. Retention — addition

**Disconnecting a mailbox or calendar.** Disconnecting immediately destroys
the access token and the refresh token Tiny CRM holds, so Tiny CRM stops
syncing and cannot read your mailbox or calendar again.

Disconnecting here does not remove the authorisation you granted at Microsoft.
Microsoft provides no way for us to revoke it on your behalf, so if you want
the permission itself withdrawn, remove Tiny CRM from the connected
applications in your Microsoft account.

You are asked what to do with what has already been imported:

- **Keep it** (the default): imported messages and meetings stay in your CRM,
  still visible only to you, and remain attached to any record they were filed
  against.
- **Delete it:** every message and meeting imported through that connection is
  deleted. Items from other sources are unaffected.

Deleting your account or workspace removes imported items with everything
else, as described above.

## § 9. Your choices — addition

**Connecting is optional and reversible.** Nothing is imported unless you
connect a mailbox or calendar yourself, and disconnecting is available at any
time in Settings → Integrations.

## The marker on each integration section, until it takes effect

*This section takes effect on {INTEGRATIONS_EFFECTIVE_ON}. Until then, email
and calendar connections are not available to customers.*

---

# DPA — Annex B

## New subprocessor row

| Subprocessor | Purpose | Where the data is stored | Basis |
| --- | --- | --- | --- |
| Sentry | Error reporting: the type and message of a fault, a filtered stack trace, the request identifier, the route path, and the identifiers of the user and workspace | United States | Verified from code and configuration; the storage location read from our Sentry organisation's Data Storage Region setting |

## Replacement for the closing sentence

Transactional email carries a name, an email address and a link — never CRM
record contents. Telemetry carries an allowlist of fields — what went wrong,
where in the code, which request, and which account — assembled explicitly
rather than captured automatically, so record contents, note text, prompts,
passwords and tokens are not attached to it. The message and stack trace that
are sent are filtered before they leave to remove database rows quoted by an
error, email addresses, and anything shaped like a credential.

---

# Customer email

**The customer email lives in `PUBLICATION-PACKAGE.md` § 3, and only there.**

This section used to hold a second copy, written when the plan was two
separate notices — Notice A for the Sentry correction and Notice B for the
integration sections. That plan was replaced by one combined email. The copy
here was not updated, and a review PDF was generated from it after the
combined email had already been agreed, which is how a stale draft reached a
reviewer.

One copy, one source. The review PDF is now assembled from the package by
`scripts/build-review-pdf.mjs` rather than from a transcription, so this
cannot recur.


# Unresolved before any of this is published or sent

None of these is a drafting question. Each needs a fact established or a
decision taken.

## Facts nobody has established yet

- [x] **Sentry's region — confirmed United States.** Read from the Sentry
      organisation's Data Storage Region setting and written into both the
      privacy notice § 5 row and the DPA Annex B row. No longer a placeholder.
- [x] **`privacy@tinycrm.biz` reaches a monitored inbox — confirmed.** A test
      message was sent and arrived. The address can stand as the contact for
      privacy questions in both documents.
- [ ] **The `MAIL_FROM` address.** Neither notice says "reply to this
      message", because whether a reply arrives anywhere depends on this, and
      the default in code is `no-reply@localhost`. The production value is set
      but encrypted and has not been read. If it accepts replies, the
      invitation can go back in.
- [ ] **Sentry's retention period.** How long an error report is kept is a
      project setting. Annex B states retention for no subprocessor, so
      omitting it is consistent — but if it is added for one, add it for all.

## Decisions

- [ ] **The effective date**, which fixes `{EFFECTIVE_DATE}` and
      `{INTEGRATIONS_EFFECTIVE_ON}` together. One decision, not two: the 30
      days run from the email, so a publication date without a send date
      cannot be measured against the commitment. At least 31 days between the
      two.
- [ ] **When the Sentry correction takes effect.**
      `{SENTRY_CORRECTION_EFFECTIVE_DATE}` is deliberately unset. An earlier
      draft said this correction took effect "immediately"; that was an
      assumption, not a decision, and it has been removed from both Notice A
      and the combined-notice paragraph. The date follows from the next
      question and is yours to set.
- [ ] **Whether the Sentry correction gets the 30 days**, or ships sooner as a
      labelled correction. The argument runs both ways. The recommendation is
      to give the 30 days: it costs only time, and the alternative asks a
      customer to accept an interpretation we wrote about an omission of ours.
- [ ] **Whether the Sentry correction ships ahead of the integration
      release.** It corrects something already happening and has no dependency
      on integrations. If it does ship first, Notice A goes alone — and the
      two dates stay independent.
- [ ] **Whether to restore the offer to confirm no connection exists.** It was
      removed because the admin panel surfaces nothing about integrations, so
      answering means a manual database query, and the answer could not
      honestly be "never" — a deleted workspace takes its records with it.

## Known gaps in the surrounding documents

- [ ] **The DPA's own change control.** `DPA-DRAFT.md` has not been executed
      with anyone, so whether its corrections need notice at all is a separate
      question from the privacy notice's § 12.
- [ ] **Whether the terms of service impose a separate
      subprocessor-notification duty.** The terms have not been read against
      these changes.

## The dates, and what they are

The placeholders are gone; real dates are written into the text so it can be
read as the finished thing. **They are proposed, not approved**, and nothing
is scheduled against them.

| | Proposed date | Status |
| --- | --- | --- |
| Publication of the page, and the customer email | **20 October 2026** | Pending approval |
| Integration provisions take effect | **23 November 2026** — 34 days later | Pending approval |
| Sentry correction | Published **20 October 2026** as a labelled correction | Pending approval. It describes processing already happening, so nothing "takes effect"; the notice is what changes |

~~`{SENTRY_REGION}`~~ — resolved to **United States**, from our own Sentry
organisation's Data Storage Region setting, and written into both disclosure
rows as a statement about where data is stored rather than where the company
is established.

Nothing here has been published, and no email has been sent.
