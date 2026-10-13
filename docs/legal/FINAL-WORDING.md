# Tiny CRM — proposed privacy wording

**Nothing here is published or sent. Every date is a placeholder.**

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

| Who | What they get | Where |
| --- | --- | --- |
| Sentry | Error reports, assembled from a fixed list of fields: the type and message of a fault, a filtered stack trace, the request identifier, the route path, and the identifiers of the user and workspace. | United States |

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

| Subprocessor | Purpose | Location | Basis |
| --- | --- | --- | --- |
| Sentry | Error reporting: the type and message of a fault, a filtered stack trace, the request identifier, the route path, and the identifiers of the user and workspace | United States | Verified from code and configuration; region read from the Sentry organisation's Data Storage Region setting |

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

Two changes may reach customers: the integration sections, and the Sentry
correction. **They are separate changes on separate timetables**, and the
wording below keeps them separate so that nobody has to work out which notice
period applies to which.

If the Sentry correction publishes on its own — the recommended order — send
**Notice A** alone now, and **Notice B** when the integration date is fixed.
If both publish together, send Notice B with Notice A's section included
beneath the divider, exactly as written.

## Notice A — the Sentry correction

**Subject:** A correction to the Tiny CRM privacy notice: an error-reporting
provider we had not listed

> Hello,
>
> We are writing to correct our privacy notice. Nothing about how Tiny CRM
> works is changing, and nothing you do needs to change.
>
> Our notice lists the companies that process data on our behalf. That list
> was incomplete: it did not name **Sentry**, which receives error reports
> from Tiny CRM when something goes wrong. Sentry has been receiving these
> reports throughout, and we should have listed it.
>
> **What an error report contains.** A fixed set of fields, assembled by hand
> rather than captured automatically: what went wrong, where in the code,
> which request, and which account. Your records, notes, documents and
> credentials are not among those fields. The fault message and stack trace
> are filtered before they are sent, to remove database rows quoted by an
> error, email addresses, and anything shaped like a credential.
>
> **What is changing:** the notice, so that it is accurate. Not the product,
> and not what we collect.
>
> This correction takes effect on {SENTRY_CORRECTION_EFFECTIVE_DATE}. The
> updated notice is at https://tinycrm.biz/privacy.
>
> If you have questions, write to privacy@tinycrm.biz.
>
> — Artifact Digital LLC, 178 N. Cuyamaca St., El Cajon, CA 92020, United
> States

## Notice B — the integration sections

**Subject:** A change to the Tiny CRM privacy notice, effective
{EFFECTIVE_DATE}

> Hello,
>
> We are adding email and calendar connections to Tiny CRM. You do not have to
> use them, and nothing changes for you unless you choose to connect an
> account. We are writing because our privacy notice is changing to describe
> them, and we give at least 30 days' notice before a material change takes
> effect.
>
> **The change takes effect on {EFFECTIVE_DATE}.** Until then, the current
> notice continues to apply in full, and email and calendar connections are
> not available to customers.
>
> **What the new sections say**
>
> If you choose to connect a mailbox or calendar:
>
> - Tiny CRM reads it so your messages and meetings appear beside the contacts
>   they concern. It stores subjects, a short preview, the sender and
>   recipients, times, and for meetings the title, location, online-meeting
>   link and start and end times. It does not store message bodies or
>   attachments.
> - The access is read-only. Tiny CRM asks for permission to read your mail
>   and calendar, and asks for no permission to send, reply, create, change or
>   delete anything. It holds no ability to do so.
> - Reading your mailbox means making requests to Microsoft for your own data,
>   using the authorisation you grant when you connect. Those requests do not
>   carry your Tiny CRM records.
> - What you import is visible to you alone — not to colleagues who share your
>   workspace. There is currently no way to share an imported item with your
>   workspace, and attaching one to a contact does not change that.
> - Imported mail and meetings are never included in a request sent to an AI
>   model provider, whatever your workspace's AI setting is.
> - Disconnecting immediately destroys the access and refresh tokens we hold,
>   so Tiny CRM stops syncing. It does not withdraw the permission at
>   Microsoft — to do that, remove Tiny CRM from the connected applications in
>   your Microsoft account. You are asked whether to keep or delete what was
>   already imported; keeping is the default.
>
> **What is not changing**
>
> Nothing about how your existing CRM records, files or account information
> are handled. If you never connect a mailbox or calendar, nothing in this
> update applies to you.
>
> You can read the updated notice in full at https://tinycrm.biz/privacy — the
> integration sections are marked with the date they take effect.
>
> If you have questions, write to privacy@tinycrm.biz.
>
> — Artifact Digital LLC, 178 N. Cuyamaca St., El Cajon, CA 92020, United
> States

### If both changes publish together

Append this beneath Notice B, under a divider, so the two are not confused:

> **Separately: a correction to the same notice.**
>
> Unrelated to the above, and on its own timetable: our subprocessor list did
> not name Sentry, which receives error reports from Tiny CRM when something
> goes wrong. It has been receiving them throughout and should have been
> listed. Nothing about how Tiny CRM works is changing — only the notice, so
> that it is accurate. What an error report contains is described in the
> notice. This correction takes effect on
> {SENTRY_CORRECTION_EFFECTIVE_DATE}.

**Two edits are required when the notices are combined, and the second is
easy to miss.**

1. The two dates are separate placeholders and may resolve to different days.
   Do not collapse them into one.
2. Notice B's closing line must change. Standing alone it reads *"If you never
   connect a mailbox or calendar, nothing in this update applies to you"* —
   true of an email about integrations, and **false** once the Sentry
   correction is in the same message, because that correction applies to
   everyone. Replace it with:

   > If you never connect a mailbox or calendar, the optional integration
   > changes do not affect you unless you connect.

   Leaving the original in a combined email would tell a customer that a
   correction about an undisclosed subprocessor does not concern them.

---

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

## The placeholders

| Placeholder | Appears in | Fixed when |
| --- | --- | --- |
| `{EFFECTIVE_DATE}` | Notice B, subject and body | The publication and send dates are approved together |
| `{INTEGRATIONS_EFFECTIVE_ON}` | The marker on each integration section | The same decision — it is the same date as `{EFFECTIVE_DATE}` |
| `{SENTRY_CORRECTION_EFFECTIVE_DATE}` | Notice A, and the combined-notice paragraph | A separate decision, on its own timetable. **Not** the same date as the two above unless you choose it to be |

~~`{SENTRY_REGION}`~~ — resolved to **United States** and written into both
disclosure rows.

No date appears anywhere in this document. Nothing here has been published,
and no email has been sent.
