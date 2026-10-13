# Publication and notification package — for approval

**Nothing in here has been published, sent or scheduled.** The dates below are
*proposals*. The repository drafts still carry placeholders, and the privacy
page is unchanged until you approve this.

---

## 1. A finding that changes the package

**The Terms incorporate the privacy notice.** § 5 of the terms of service:

> How we handle your data is described in the privacy notice, **which forms
> part of these terms.**

So a material change to the privacy notice is a material change to the terms,
and the terms' own § 11 applies as well as the privacy notice's § 12:

> We will give at least **30 days' notice** by email to your account address
> before a subscription price increase or a material change to these terms
> applies to an existing subscription. **You can cancel before it takes
> effect.**

Two consequences:

1. **The notice period is unchanged** — both clauses say 30 days, so one
   notice satisfies both. No extra time is needed.
2. **Subscribers gain a right the privacy notice alone does not give them:**
   to cancel before the change takes effect. § 11 scopes this to "an existing
   subscription", so it attaches to paying accounts, not to Free. The email
   must say so to them, because we promised it. The draft email did not, and
   now does.

This is the one substantive thing the Terms added. Nothing in them imposes a
separate subprocessor-notification duty — the words "subprocessor" and
"sub-processor" do not appear.

---

## 2. Proposed dates

| | Date | |
| --- | --- | --- |
| **Send** | **Tuesday 20 October 2026** | 7 days from today, for approvals and a tested send mechanism |
| **Effective** | **Monday 23 November 2026** | **34 days** after sending |

34 days, not 31. The minimum is 30 and you asked for at least 31; the extra
days absorb a send that slips by a day or two without anyone having to
recalculate whether the commitment still holds. A Monday effective date means
any confusion lands on a working day.

**Both changes on one date.** The integration sections and the Sentry
correction share 20 October and 23 November. That is a recommendation, not a
constraint:

- *One email, one date* (proposed): simplest for the reader, one deadline to
  remember, and the correction gets the full 30 days — which is the
  recommendation already recorded for it.
- *Two emails*: the correction goes sooner on its own. It fixes something
  already happening, so there is an argument for not making it wait. It costs
  a second email to every account and two deadlines in people's heads.

If you take the second option, the combined-notice paragraph comes out of the
email below and Notice A from `FINAL-WORDING.md` goes separately.

---

## 3. The exact final email

One message, both changes, clearly separated. No "reply to this message" —
the `MAIL_FROM` address has not been confirmed to accept replies. No offer to
confirm historical connections — the admin panel cannot answer it.

> **Subject:** Changes to the Tiny CRM privacy notice, effective 23 November
> 2026
>
> Hello,
>
> Our privacy notice is changing on **23 November 2026**. There are two
> changes, and they are unrelated to each other. Until that date the current
> notice continues to apply in full.
>
> ---
>
> **1. Email and calendar connections (optional, new)**
>
> We are adding the ability to connect a mailbox or calendar. You do not have
> to use it, and nothing changes for you unless you choose to connect an
> account.
>
> If you do connect one:
>
> - Tiny CRM reads it so your messages and meetings appear beside the
>   contacts they concern. It stores subjects, a short preview, the sender and
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
> - The access token and the refresh token are both encrypted before they are
>   stored.
> - Disconnecting immediately destroys both of those tokens, so Tiny CRM stops
>   syncing. It does not withdraw the permission at Microsoft — to do that,
>   remove Tiny CRM from the connected applications in your Microsoft account.
>   You are asked whether to keep or delete what was already imported; keeping
>   is the default.
>
> **The optional integration changes do not affect you unless you connect.**
>
> ---
>
> **2. A correction: an error-reporting provider we had not listed**
>
> This one applies to everybody, and nothing about how Tiny CRM works is
> changing.
>
> Our notice lists the companies that process data on our behalf. That list
> was incomplete: it did not name **Sentry**, which receives error reports
> from Tiny CRM when something goes wrong, and is based in the United States.
> Sentry has been receiving these reports throughout, and we should have
> listed it.
>
> An error report is a fixed set of fields, assembled by hand rather than
> captured automatically: what went wrong, where in the code, which request,
> and which account. Your records, notes, documents and credentials are not
> among those fields. The fault message and stack trace are filtered before
> they are sent, to remove database rows quoted by an error, email addresses,
> and anything shaped like a credential.
>
> We are correcting the notice, not the product.
>
> ---
>
> **If you have a paid subscription**, you may cancel before 23 November 2026
> if you do not wish to continue under the updated notice. Cancelling is in
> Settings → Plan & billing.
>
> You can read the updated notice in full at https://tinycrm.biz/privacy. The
> integration sections are marked with the date they take effect.
>
> If you have questions, write to privacy@tinycrm.biz.
>
> — Artifact Digital LLC, 178 N. Cuyamaca St., El Cajon, CA 92020, United
> States

### Why it is shaped this way

- **The two changes are numbered and divided**, because one is optional and
  one applies to everybody. A reader who connects nothing still needs to read
  part 2.
- **"The optional integration changes do not affect you unless you connect"**
  replaces "nothing in this update applies to you", which would be false in a
  combined email.
- **The cancellation line is an obligation**, not a courtesy — terms § 11. It
  is scoped to paid subscriptions because the clause is.
- **No call to action.** A privacy notice is not an announcement.

---

## 4. The privacy page: current and future, distinguished

Two changes to `src/app/(marketing)/privacy/page.tsx`, and one to
`src/lib/legal.ts`.

**`LEGAL_EFFECTIVE_ON` stays `2026-10-05`.** The notice in force today remains
in force and remains the authoritative text until 23 November. A second
constant carries the future date:

```ts
/** The notice in force today. Unchanged by a pending future change. */
export const LEGAL_EFFECTIVE_ON = "2026-10-05";

/** When the integration and subprocessor sections take effect. */
export const INTEGRATIONS_EFFECTIVE_ON = "2026-11-23";
```

**How the page distinguishes them.** A banner at the top, and a marker on each
affected section:

> **This notice is changing on 23 November 2026.** Two sections are marked
> below. Until that date, the current text applies; the marked text does not
> yet.

and on each of §§ 2, 4, 5, 6, 7, 8, 9 where integration text is added:

> *Takes effect 23 November 2026. Until then, email and calendar connections
> are not available to customers.*

**The Sentry row is a special case and should be handled differently.** It
describes something already true. Marking it "takes effect 23 November" would
be the opposite of a correction — it would imply Sentry starts receiving
reports then. Proposed treatment:

> **Added as a correction.** Sentry has received error reports throughout;
> this row should have been here already.

So the subprocessor row goes in **as current text with a correction note**,
while the integration sections go in as **future text**. One email announces
both; the page shows them differently because they are different.

---

## 5. Recipient count — a dry run you run, not me

`scripts/notice-recipients.mjs` counts the audience and **has no send path at
all**. Counting and mailing are different operations, and a script that can do
both is one flag away from mailing everybody by accident.

```
node scripts/notice-recipients.mjs
node scripts/notice-recipients.mjs --sample   # 5 addresses, local part masked
```

It reports: accounts, **distinct addresses** (the send list), how many are
suspended, how many unverified, how many malformed, a breakdown by stored
plan, the count of live subscriptions (the people owed the cancellation
right), and the top recipient domains as a shape check.

**Every account, not every owner.** The notice governs what we do with a
person's data, so a member whose colleague owns the workspace is a data
subject too. Suspended accounts are included — disabling an account does not
end the obligation to tell that person what we do with their data.

I cannot run it; it needs the production connection string through the hidden
prompt. Run it before approving the send so the count is known rather than
assumed.

---

## 6. Delivery and retry plan

**No send mechanism exists yet.** `src/lib/mail.ts` sends transactional mail
one message at a time — verification, reset, invitations. There is nothing
that sends to every account, and nothing should be improvised on the day.

### What it must do

| Property | Why |
|---|---|
| **Idempotent per recipient** | A retry must not send twice. Record a delivery row per address before sending, keyed so a re-run skips what already went. |
| **Resumable** | A run that dies halfway continues rather than restarting. Follows from the above. |
| **Rate limited** | Resend and the underlying SES have throughput limits; exceeding them produces throttling that looks like failure and invites a double send. |
| **Bounded concurrency** | A handful at a time, not the whole list. |
| **Logged per recipient** | Address, timestamp, provider message id, outcome. "When was notice given" must be answerable from a log, not a recollection. |
| **Dry run by default** | `--apply` to send, like every other production script here. |
| **Hard recipient cap** | Refuse if the list exceeds the count you approved, so a query change cannot silently widen the audience. |

### Retry policy

- **Hard bounce** (no such address): do not retry. Record it. Follow up
  individually if the account is active.
- **Soft bounce / throttle / 5xx**: retry with exponential backoff, up to 5
  attempts over ~24 hours, honouring any `Retry-After`. The job runner in
  `src/lib/jobs.ts` already does this; the sender should ride on it rather
  than growing its own loop.
- **Still failing after 5 attempts**: dead-letter, and surface the list. Those
  people have not been given notice, and the gap should be visible rather than
  absorbed.

### Verifying the send

Afterwards, three numbers must agree: the approved recipient count, the
delivery rows written, and the provider's accepted count. A discrepancy means
somebody was not told, which matters when the clause says "at least 30 days'
notice by email to your account address".

---

## 7. Still open before approval

- [ ] **The two dates** — 20 October and 23 November, or your alternatives.
- [ ] **One email or two** — combined is recommended.
- [ ] **Whether the Sentry correction waits for 23 November** or publishes
      sooner as a labelled correction, with the integration sections still
      future-dated. The recommendation remains to give it the 30 days.
- [ ] **The `MAIL_FROM` address.** Unread. If it accepts replies, "reply to
      this message" can go back into the email; if not, the current wording
      stands.
- [ ] **The recipient count**, from the dry run.
- [ ] **The send mechanism**, which does not exist and needs building and
      testing against a known-complete list.
- [ ] **Someone other than its author reads the email.**

## Confirmed, and no longer open

- [x] **Sentry's region: United States**, from the organisation's Data Storage
      Region setting. Written into both disclosure rows.
- [x] **`privacy@tinycrm.biz` reaches a monitored inbox** — test message sent
      and received.
- [x] **The Terms were checked.** They incorporate the privacy notice, which
      adds the cancellation right above. No separate subprocessor-notification
      duty.
