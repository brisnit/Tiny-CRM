# Customer notice email — privacy update for email and calendar connections

**Status: draft for review. Not sent, not scheduled, not queued.** No send
path has been built for this and none should be until the wording is agreed.

This is the email that discharges § 12 of the privacy notice:

> If this notice changes materially, we will give at least **30 days' notice
> by email to your account address**. Changes required sooner by law may take
> effect sooner, with notice as appropriate.

---

## How it must be sent

Three properties, each of which the clause actually requires and which are
easy to lose in the sending:

- **To the account address**, not to a marketing list. The clause names the
  account address specifically, and a customer who has unsubscribed from
  product mail is still owed this. It is transactional, not marketing.
- **To every account**, not only to workspace owners. The notice governs what
  Tiny CRM does with a person's data; a member whose colleague owns the
  workspace is still a data subject.
- **On the day the updated notice is published**, with the effective date in
  the body. The 30 days are counted from the notice being given, and the
  effective date must already be fixed and visible on the page when the email
  lands — otherwise the recipient cannot check what they have been told.

Record the send date. If anybody later asks when notice was given, the answer
should be a log entry, not a recollection.

---

## Subject

> A change to the Tiny CRM privacy notice, effective {EFFECTIVE_DATE}

Deliberately not "Important update" or "We've updated our terms": it says what
changed and when it starts, so the decision to open it is informed. No
pre-header gimmick.

---

## Body

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
> not available.
>
> **What the new sections say**
>
> If you choose to connect a mailbox or calendar:
>
> * Tiny CRM reads it so your messages and meetings appear beside the contacts
>   they concern. It stores subjects, a short preview, the sender and
>   recipients, times, and for meetings the title, location, online-meeting
>   link and start and end times. **It does not store message bodies or
>   attachments.**
> * **The access is read-only.** Tiny CRM asks for permission to read your
>   mail and calendar, and asks for no permission to send, reply, create,
>   change or delete anything. It holds no ability to do so.
> * **What you import is visible to you alone** — not to colleagues who share
>   your workspace. There is currently no way to share an imported item with
>   your workspace, and attaching one to a contact does not change that.
> * **Your correspondence is never sent to an AI provider**, whatever your
>   workspace's AI setting is. Connecting a mailbox lets Tiny CRM show your
>   correspondence to you; it is not consent to send it anywhere else.
> * **Disconnecting destroys the stored access immediately**, and asks whether
>   to keep or delete what was already imported. Keeping is the default.
>
> **What is not changing**
>
> Nothing about how your existing CRM records, files or account information
> are handled. If you never connect a mailbox or calendar, nothing in this
> update applies to you.
>
> You can read the updated notice in full at https://tinycrm.biz/privacy —
> the integration sections are marked with the date they take effect.
>
> If you have questions, or you would like us to confirm that no connection
> has ever been made on your account, reply to this message or write to
> privacy@tinycrm.biz.
>
> — Artifact Digital LLC
> 178 N. Cuyamaca St., El Cajon, CA 92020, United States

---

## Wording choices worth a second opinion

- **"You do not have to use them"** is in the first line on purpose. Most
  recipients will never connect anything, and the honest headline for them is
  that this does not affect them. Burying that under the detail would make a
  no-op change read as alarming.
- **"never sent to an AI provider"** is stated flatly because the code states
  it flatly — the exclusion keys on an immutable provenance column, not on a
  setting. If that ever softens to "by default", the email has to soften with
  it, and `tests/unit/integration-privacy-copy.test.ts` is what would fail
  first.
- **The offer to confirm no connection exists** is there because a customer
  cannot easily prove a negative about their own account, and the question
  "has anyone connected my mailbox?" is exactly the one this email provokes.
  It should be answerable from the admin panel before the email goes out.
- **No link to connect anything.** This is a notice, not an announcement. A
  call to action in a privacy email makes consent look like marketing.

## Before this is sent

- [ ] Wording agreed, including the two paragraphs above that are mine rather
      than obligatory.
- [ ] `{EFFECTIVE_DATE}` fixed, at least 31 days out, and already live on
      /privacy with the integration sections marked pending.
- [ ] A send mechanism exists that reaches **every** account address, and has
      been tested against a list that is known-complete rather than a query
      somebody wrote that morning.
- [ ] Someone other than its author has read it.
- [ ] The send is logged with its date and recipient count.
