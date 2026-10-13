# Customer notice email — privacy update for email and calendar connections

**Status: draft for review. Not sent, not scheduled, not queued.** No send
path has been built for this and none should be until the wording is agreed.

**`{EFFECTIVE_DATE}` is a placeholder and stays one.** No date appears
anywhere in this draft. It is fixed only when you approve the publication and
send date together — they are one decision, because the 30 days are counted
from this email and an effective date without a send date cannot be measured
against the clause.

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

## Two notices, kept apart

Two changes may reach customers: the integration sections and the Sentry
correction. They are **separate changes on separate timetables** — the Sentry
correction describes something already happening and is recommended to ship
first, while the integration sections wait on a date that has not been set.

So the wording in `FINAL-WORDING.md` is two notices, not one:

- **Notice A** — the Sentry correction, sent alone when that publishes.
- **Notice B** — the integration sections, sent when the effective date is
  fixed.
- If both publish together, Notice B carries Notice A's substance beneath a
  divider, under the heading *"Separately: a correction to the same notice"*,
  so nobody has to work out which notice period applies to which change.

Mixing them into one undifferentiated email would be the worst option
available: a customer would read a 30-day notice about an optional feature and
a correction taking effect immediately as though they were one thing, and
could not tell which deadline governed what.

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
> not available to customers.
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
> * Reading your mailbox means making requests to Microsoft for your own data,
>   using the authorisation you grant when you connect. Those requests do not
>   carry your Tiny CRM records.
> * **What you import is visible to you alone** — not to colleagues who share
>   your workspace. There is currently no way to share an imported item with
>   your workspace, and attaching one to a contact does not change that.
> * **Imported mail and meetings are never included in a request sent to an AI
>   model provider**, whatever your workspace's AI setting is.
> * **Disconnecting immediately destroys the access and refresh tokens we
>   hold**, so Tiny CRM stops syncing. It does not withdraw the permission at
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
> You can read the updated notice in full at https://tinycrm.biz/privacy —
> the integration sections are marked with the date they take effect.
>
> If you have questions, write to privacy@tinycrm.biz.
>
> — Artifact Digital LLC
> 178 N. Cuyamaca St., El Cajon, CA 92020, United States

---

## Wording choices worth a second opinion

- **"You do not have to use them"** is in the first line on purpose. Most
  recipients will never connect anything, and the honest headline for them is
  that this does not affect them. Burying that under the detail would make a
  no-op change read as alarming.
- **"never included in a request sent to an AI model provider"** is stated
  flatly because the code states it flatly — the exclusion keys on an
  immutable provenance column, not on a setting. The scope is deliberate: the
  predicate is applied in the three places that build a model-provider
  request, and nowhere else, so a broader claim about "anywhere else" or
  "everything that leaves our servers" would cover paths it does not touch.
  If it ever softens to "by default", the email has to soften with it, and
  `tests/unit/integration-privacy-copy.test.ts` is what would fail first.
- **The Microsoft bullet exists** because "read-only" alone invites the
  reading that nothing goes to Microsoft at all. Requests do: that is how
  reading a mailbox works. Saying so costs a line and avoids a correction
  later.
- **The disconnect bullet names both tokens and the limit of what we can
  revoke.** Microsoft offers no revocation endpoint for delegated grants, so
  the authorisation survives a disconnect until the customer removes it in
  their Microsoft account. Implying otherwise would be the most consequential
  overstatement in the email.
- **The offer to confirm no connection exists has been removed**, and this is
  the change I would most like a second opinion on. It was a good idea: the
  question "has anyone connected my mailbox?" is exactly the one this email
  provokes, and a customer cannot easily prove that negative themselves. But
  the admin panel surfaces nothing about integrations — `customerDetail`
  selects no integration field at all — so answering it means an operator
  writing a database query by hand, per request. Worse, the answer could not
  be "never": a connection leaves an `Integration` row that survives a
  disconnect, but a deleted workspace takes its rows with it, so the honest
  answer is about what exists now, not about all history.

  Three ways forward, in the order I would pick them: drop the offer (done
  here); or narrow it to what is answerable — "we can tell you whether any
  connection exists on your account" — and accept the manual query; or build
  it into the admin panel first and then offer it. Re-adding an unqualified
  "never" is the one option I would argue against.

- **"reply to this message" has been removed, pending one check.** The body
  said to reply or write to privacy@tinycrm.biz. Whether a reply arrives
  anywhere depends on the `MAIL_FROM` address, and the default in code is
  `no-reply@localhost`. The production value is set but encrypted, so I have
  not read it. If the From address accepts replies, put the phrase back; if
  it is a no-reply address, inviting a reply to a privacy notice is a small
  but real broken promise.
- **No link to connect anything.** This is a notice, not an announcement. A
  call to action in a privacy email makes consent look like marketing.
- **"not available to customers"**, not "not available". The narrower phrasing
  is deliberate and should not be tidied away. Our own canary mailbox has
  already been imported during development — our correspondence, our
  workspace, us as controller, no customer data involved — so a flat "not
  available" or "nothing has been collected" would be a claim we cannot
  stand behind. What customers need to know is that *they* cannot connect
  anything yet, which is both true and the thing they are actually asking.

## Before this is sent

- [ ] Wording agreed, including the two paragraphs above that are mine rather
      than obligatory.
- [ ] `{EFFECTIVE_DATE}` fixed, at least 31 days out, and already live on
      /privacy with the integration sections marked pending.
- [ ] A send mechanism exists that reaches **every** account address, and has
      been tested against a list that is known-complete rather than a query
      somebody wrote that morning.
- [ ] The `MAIL_FROM` address is known, and either accepts replies or the
      email does not invite one
- [ ] `privacy@tinycrm.biz` is confirmed to be a mailbox somebody reads.
      `tinycrm.biz` has MX records (`mx1`/`mx2.spacemail.com`), so the domain
      accepts mail — that is **not** the same as the address existing or
      being monitored, and I cannot establish either from here
- [ ] Someone other than its author has read it.
- [ ] The send is logged with its date and recipient count.
