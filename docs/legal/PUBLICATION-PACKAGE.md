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

> **Both dates are provisional and neither is approved.** 20 October and 23
> November appear throughout this document, in the email and in the page
> copy, so that the package can be read as the finished thing. Nothing is
> scheduled against them. The Sentry correction's publication timing is
> separately unapproved — see the open item in § 9; the email in § 3 is
> written for the recommended option and changes if you take the other.

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

**Two provisional elements, marked inline below and not approved.**

1. **The dates.** 20 October (send) and 23 November (effective).
2. **When the Sentry correction publishes.** The email is written for the
   recommended option — the correction goes live with the page on the send
   date, because it describes processing already happening. The alternative
   is to hold it to 23 November with the integration sections. The two
   passages marked `[PROVISIONAL …]` are the only text that differs between
   those options; replacement wording for each is given directly after the
   email. Nothing else in the message changes.

> **Subject:** Changes to the Tiny CRM privacy notice, with new sections
> effective 23 November 2026
>
> Hello,
>
> We have updated our privacy notice. There are two changes, they are
> unrelated to each other, and they do not take effect at the same time.
>
> - **The first takes effect on 23 November 2026.** It covers an optional new
>   feature. Until that date the current notice continues to apply to it in
>   full.
> - **The second is live on the page now.** It is a correction to our list of
>   providers, and it describes something that was already the case.
>   `[PROVISIONAL — timing of the Sentry correction not yet approved]`
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
> This one applies to everybody, it is on the page now rather than on 23
> November, and nothing about how Tiny CRM works is changing.
> `[PROVISIONAL — timing of the Sentry correction not yet approved]`
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

### If the correction is held to 23 November instead

Replace the two marked passages, and change nothing else:

| | Recommended (as written above) | If held to 23 November |
| --- | --- | --- |
| Opening bullet 2 | "**The second is live on the page now.** It is a correction to our list of providers, and it describes something that was already the case." | "**The second also takes effect on 23 November 2026.** It is a correction to our list of providers, describing something that was already the case; we are giving it the same notice period." |
| Part 2 opening line | "This one applies to everybody, it is on the page now rather than on 23 November, and nothing about how Tiny CRM works is changing." | "This one applies to everybody, and nothing about how Tiny CRM works is changing." |

Neither version may say or imply that Sentry begins processing on 23
November. In the held version the *notice* takes effect then; the processing
has been happening throughout, and the paragraph saying so stays either way.

The subject line is unchanged in both: it dates only the new sections.

### Why it is shaped this way

- **The two changes are numbered and divided**, because one is optional and
  one applies to everybody. A reader who connects nothing still needs to read
  part 2.
- **The opening dates them separately.** An earlier draft opened with "our
  privacy notice is changing on 23 November", which is false about part 2: the
  correction is live when the page publishes, and Sentry has been receiving
  error reports throughout. One sentence covering both changes could only be
  right about one of them.
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

## 5b. Recipient review — separating fixtures from people

Your count: **28 accounts, 17 on test domains, 0 live subscriptions.** That
last number resolves one question immediately — nobody has a subscription, so
**the cancellation right in terms § 11 currently applies to nobody.** The line
stays in the email (someone may subscribe before the send), but it costs
nothing if it still applies to no one on the day.

`scripts/review-recipients.mjs` is read-only. It deletes nothing, changes
nothing, sends nothing, and is not wired to anything that acts on its output.

### It classifies on provenance, not on how an address looks

A domain heuristic fails in both directions, and one of them is dangerous:

- it would **exclude a real customer** at an unusual domain;
- it would **include the seeded demo accounts**, which use realistic
  addresses on purpose (`prisma/seed/data.ts` is full of names like
  `greg.hall@outlook.com`).

So each account is matched against the code that actually mints it:

| Rule | Evidence |
| --- | --- |
| `seed-demo-owner` | `prisma/seed/index.ts` creates `owner@tinycrm.app` verbatim |
| `seed-demo-free` | the same file creates `demo@tinycrm.app` verbatim |
| `canary-local` | `scripts/canary-local.ts` creates `canary@localhost.test` |
| `unit-fixture` | `tests/helpers/fixtures.ts` mints `<label>-<role>-<n>@test.local` |
| `verify-seed` | `prisma/seed/test-seed.ts` mints `<label>-<role>-<run>@verify.local` |
| `reserved-test-tld` | RFC 2606 reserves `.test`, `.invalid`, `.localhost` — not registrable, so undeliverable |
| `example-domain` | RFC 2606 reserves `example.com/net/org` for documentation |

The rules were exercised against eleven known addresses, including the three
real ones and the realistic-looking seeded contact domain: all eleven
classified correctly.

### What it will not exclude on

- **An unverified address.** Someone who never clicked the link is still a
  data subject and is still owed the notice. Reported, never acted on.
- **No subscription.** Everyone is in that position; it distinguishes nobody.
- **Dormancy.** Not signing in recently is not evidence of being synthetic.

### Anything it cannot place goes to you

An address no rule matches, on an account with no sign-in, no workspace, no
membership and no records, is reported as **AMBIGUOUS** with those signals
listed — not excluded. Three weak signals are a reason for a person to look,
not for a script to decide.

### Revised after your review of the first run

Three corrections, all from what you found:

**All nine `tinycrm-test.local` accounts are in the test-account group**, not
just the five perf-probe and tzprobe ones. The rule matches the domain, so
every account on it is grouped regardless of what it contains.

**Populated accounts are no longer treated as evidence of a real person.** An
earlier version used emptiness as a signal, which implied the reverse — and
that is backwards for exactly these accounts: a performance probe creates a
workspace and thousands of records, and a timezone probe signs in. Being busy
is what a load test looks like. Activity counts are now *printed beside* each
account for you to weigh, and never used to promote anything to INCLUDE.

**The three plus-tagged addresses are proposed for exclusion on
operator-history evidence** — `brisnit+terms-check`, `brisnit+readiness`,
`brisnit+rc`. Gmail routes a plus tag to the same inbox, so these are the same
person as `brisnit@gmail.com`, who is on the list in their own right; mailing
the tags would send one human four copies.

### Two kinds of evidence, labelled apart

This matters enough to show in the output rather than blur:

| Class | What it means | Rules |
| --- | --- | --- |
| `code-provenance` | A line in this repository mints the address | the two `tinycrm.app` demo accounts, `canary-local`, `@test.local`, `@verify.local` |
| `reserved-by-rfc` | The domain cannot be registered, so cannot receive mail | `.test` / `.invalid` / `.localhost`, `example.com/net/org` |
| `operator-history` | **No code mints these.** They rest on your account of work you did, corroborated by the address shape | `tinycrm-test.local`, the three plus tags |

I checked before writing those rules: nothing in the tree creates
`tinycrm-test.local`, `perf-probe` or `tzprobe`. The nearest equivalents —
`perf-regression.ts` and `db-differences.ts` — both use `@test.local`. So the
third class is genuinely weaker than the first two, and saying so is the point
of separating them.

The plus-tag rule therefore matches the three addresses **exactly**. Any other
`brisnit+` tag goes to AMBIGUOUS rather than being swept up, because a real
customer may legitimately use plus-addressing to sign up.

### designbysmith@gmail.com stays in

No rule matches it, so it is a recipient. The output says so explicitly, under
a heading that states the default: an address on an ordinary consumer or
business domain stays in unless you confirm it is a test. It will not move
without you saying so.

### The rules are tested

Sixteen addresses, including the ones that must **not** match: `brisnit@gmail.com`
(the owner's real account), `brisnit+newsletter@gmail.com` (an unrecognised
tag), `designbysmith@gmail.com`, and the two other real accounts. All sixteen
behave as specified.

### Two defects found by running it, both fixed

**The plus-tag rule matched nothing.** The real addresses carry a run suffix —
`brisnit+terms-check-32ff0980@gmail.com`, not `brisnit+terms-check@gmail.com`.
I wrote the rule from the shorthand in the request rather than from the
addresses themselves, so `includes()` never matched and all three fell through
to AMBIGUOUS. That is the safe direction to fail, and still wrong.

The first fix was a pattern — a known tag plus eight hex characters — and
that was wrong in the other direction. A pattern in an exclusion rule is a
standing instruction to drop future unknowns: it would have matched an address
created tomorrow that nobody had confirmed.

**It is now an exact allowlist of the three confirmed addresses**, suffixes
included, and nothing else. A bare variant, the same tag with a different
suffix, or a new tag of the same shape all go to AMBIGUOUS for review rather
than being excluded automatically. A fourth test account will need confirming
individually, which is the point rather than an inconvenience: the review loop
is cheap, and dropping a real customer from a legal notice is not.

**The header comment contradicted the classification.** It said every account
"is matched against provenance the code actually creates" and listed only the
code-provenance rules. That stopped being true the moment `operator-history`
was added. Rewritten to describe all three classes and to say plainly that
operator history is the weakest, rather than letting it inherit the authority
of the other two.

### Verified against your snapshot

Replaying the 28 accounts as reported — nine on `tinycrm-test.local` with five
populated, the three suffixed plus tags, the code-provenance fixtures, and
eight real people:

```
accounts    28
INCLUDE      8
EXCLUDE     20
AMBIGUOUS    0      expected 8 / 20 / 0 : MATCHES
```

The five populated probes are excluded on the domain rule regardless of their
4,200 records, which is the correction you asked for. `designbysmith@gmail.com`
and `brisnit@gmail.com` are both in the included eight.

### Expected shape, to be confirmed by running it

From your 17-on-test-domains figure, most of those should land under
`unit-fixture` and `reserved-test-tld`, leaving roughly a dozen real
accounts. I am not asserting the split — run it and the output will give
exact counts with a reason beside every exclusion.

```
node scripts/review-recipients.mjs
node scripts/review-recipients.mjs --full   # every account with its verdict
```

### It is a snapshot, deliberately

Accounts created between the review and the send are not in it. Re-run it on
the day. `send-notice.ts --live` enforces this independently: it refuses when
the list has grown past the `--max` you approved, so a quiet increase cannot
widen the audience without someone noticing.

---

## 6. The timeline, stated so Sentry is not misread

The two changes publish on the **same day** and take effect on **different
terms**. The page and the email must both carry that distinction, because the
obvious simplification — "everything changes on 23 November" — would say
something false about Sentry.

| | Publishes | Takes effect | What the reader should conclude |
| --- | --- | --- | --- |
| **Sentry disclosure** | 20 Oct 2026, with the email | **Already true.** The row describes processing that has been happening | "They were already using this and had not said so. Now they have." |
| **Integration sections** | 20 Oct 2026, marked as pending | **23 Nov 2026** | "This is coming. It does not affect me unless I connect." |

**Sentry does not start processing on 23 November, and nothing may imply it
does.** It has been receiving error reports throughout. The correction is to
the notice, not to the product, and the page says so in those words:

> **Added as a correction.** Sentry has received error reports throughout;
> this row should have been here already.

So on 20 October the page shows:

- the **current** notice, still in force, still authoritative;
- the **Sentry row inside it**, live immediately, labelled as a correction to
  what was already happening;
- the **integration sections**, each marked *"Takes effect 23 November
  2026"*, visible but explicitly not yet in force.

And a banner at the top naming only what is pending:

> **Parts of this notice change on 23 November 2026.** The sections about
> email and calendar connections are marked below and do not apply until
> then. Everything else on this page, including the subprocessor list, is in
> force now.

That last clause is the one that keeps Sentry honest: the subprocessor list is
**in force now**, not pending.

### Which revised provisions take effect 23 November

Only these, and only if a customer connects something:

§ 2 (what is collected) · § 4 (how it is used) · § 5 Microsoft paragraph ·
§ 6 (AI exclusion) · § 7 (token encryption) · § 8 (disconnect and retention) ·
§ 9 (your choices).

The § 5 **subprocessor table row for Sentry** is not in that list. It is live
on publication.

---

## 7. Delivery and retry plan

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

### Reconciling delivery by hand

There is no delivery webhook, so for this campaign the outcomes are recorded
manually. Eight recipients is small enough for a person to read the dashboard
and write down what happened. This is a decision about *this* campaign, not a
general method — at a hundred recipients it would be a bad one.

The procedure, after the send:

1. Open the Resend dashboard, **Emails**, and filter to the send window.
2. For each recipient read the **status** and the **message id** (`re_…`).
3. Write one line per recipient into a CSV:

   ```
   email,status,providerMessageId
   someone@example.com,delivered,re_1a2b3c4d
   other@example.com,bounced,re_2b3c4d5e
   ```

4. Dry-run it, which validates without writing:

   ```
   npx tsx scripts/send-notice.ts --notice=<id> --record=outcomes.csv
   ```

5. Then `--apply` to write the outcomes into the ledger, and `--reconcile` to
   see the gate.

`--record` refuses the whole file rather than part of it. It refuses on a
malformed line, a status other than `delivered` or `bounced`, an address with
no ledger entry, **a recipient appearing more than once**, and **a message id
that is not the one that recipient's send recorded** (or a missing id where
the send recorded one). All of them were exercised.

The last two exist because of how this particular error is made. Copying a
dashboard by hand puts the id column one row out of step with the addresses
beside it, and a shifted column is invisible in the resulting file — every
line is well formed. Checking each id against the one already written at
send time turns an invisible transcription error into a refusal; a shifted
column now fails on every row it touched. A duplicated recipient is refused
rather than resolved, because two lines that disagree would otherwise record
whichever was typed last. It preserves the
acceptance timestamp on the row, because the notice window is measured from
it and overwriting it would silently move everyone's deadline.

**What it does not do.** It records what a person read off a dashboard. It
cannot tell you the dashboard was read correctly, it has no provider
signature behind it, and `delivered` from Resend means the receiving server
accepted the message — not that anyone read it. A webhook remains the thing
that would make this trustworthy at any scale.

---

## 8. If notice is late, fails, or cannot be confirmed

The effective date is only meaningful if notice was actually given. These
rules are written down now, before there is any pressure to wave one through.

**The clock runs per recipient, from when their notice was accepted.** Not
from the day the run started. Someone reached three days late is owed 30 days
from *their* day.

| Situation | Effect on the effective date | Effect on activation |
| --- | --- | --- |
| Run completes, all accepted, ≥31 days before the date | None | Integrations may be enabled on the date |
| Any recipient **never attempted** | **The date does not apply to them.** Send, then their 30 days run from that send | Hold activation until every recipient has had 30 days |
| Any recipient **failed at send** after retries | Same — they have not been given notice | Same |
| Send slips so any recipient has **fewer than 30 days** | **Move the effective date**, do not shorten the notice | Activation follows the moved date |
| **Unresolved** (accepted, no delivery outcome recorded) | Date stands | **Hold.** Reconcile from the dashboard; if it still cannot be resolved, a person decides |
| Confirmed **bounced** | Treat as not given: correct the address or reach them another way | **Hold** for those accounts |

**Unresolved and bounced both block activation, by your decision.** An earlier
version of this section had unresolved *not* blocking, on the argument that
the commitment is to give notice to the address on record and is discharged
by sending — not a guarantee of reading. That argument stands on its own
terms, and the position has still been overridden: with manual reconciliation
available, an unresolved recipient is a recipient nobody has looked at yet,
and that is a different thing from one whose delivery is genuinely
unknowable.

The practical consequence, stated plainly: the gate stays shut until every
recipient is recorded `delivered`. If the dashboard cannot resolve somebody —
no row, an ambiguous status — the gate will not open by itself and will not
time out. Someone has to look at that recipient and decide, and the decision
should be written down next to this paragraph when it happens.

**The asymmetry is deliberate.** Moving a date costs a little embarrassment.
Activating a feature for someone who was never told about it is the thing the
clause exists to prevent, and it cannot be undone afterwards.

**Activation is gated on the reconciliation, not the calendar.** Before the
`integrations` flag is enabled for anyone, `--reconcile` must show all five:
every recipient attempted, zero failed, **zero unresolved**, **zero bounced**,
and **the latest acceptance** at least 30 days earlier. Numbers from the
ledger, not a date in a diary. Each failing condition is printed as its own
line under `NOT PERMISSIBLE`, so a run that is blocked for two reasons says
so twice rather than reporting the first and stopping.

**That said "earliest" until now, and it was wrong.** The commitment is to
each person, so it is met only when whoever was notified *last* has had their
30 days. With a single-batch send the two readings agree, which is why the
error read fine. With a staggered send they do not:

> A accepted on day 0, B accepted on day 10 after a retry. On day 31 the
> earliest acceptance is 31 days old and the old rule said go. B has had 21
> days — and B is the person who was hardest to reach in the first place.

The rule now lives in `src/lib/legal/notice-window.ts` rather than in prose,
is computed from the maximum acceptance time, and is covered by eleven tests
including the staggered case. Reverting it to the earliest fails three of
them. `--reconcile` prints the window and an explicit activation gate.

**An unreadable acceptance timestamp blocks the check.** The first version
filtered bad timestamps out and computed the window from what remained, so
that one `NaN` could not poison every comparison. That was right about the
symptom and wrong about the remedy: discarding means a recipient whose
acceptance time cannot be read silently stops counting, and the window is
then computed from the others — which is *more* permissive, not less. A
recipient whose acceptance time is unknown cannot be shown to have had their
30 days. The window now refuses, names the count, and offers no date. Tested
with one valid 60-day-old acceptance plus one unreadable one: refused, and
the readable acceptance is still counted and reported so the ledger can be
repaired.

---

## 9. Still open before approval

- [ ] **The two dates** — 20 October and 23 November, or your alternatives.
- [ ] **One email or two** — combined is recommended.
- [ ] **Whether the Sentry correction waits for 23 November** or publishes
      sooner as a labelled correction, with the integration sections still
      future-dated. The recommendation remains to give it the 30 days.
- [ ] **The `MAIL_FROM` address.** Unread. If it accepts replies, "reply to
      this message" can go back into the email; if not, the current wording
      stands.
- [ ] **The recipient count**, from the dry run.
- [x] ~~Delivery reconciliation.~~ **Built and tested** —
      `--record` reads a CSV of dashboard outcomes into the ledger, and the
      activation gate blocks on unresolved and on bounced. Exercised against
      a throwaway local ledger of 5: all unresolved → refused despite the
      window having elapsed; 3 delivered + 1 bounced + 1 unrecorded → refused
      on both counts, listed separately; all 5 delivered → permitted. A
      corrupted acceptance timestamp → refused, with no date and no countdown
      printed. Malformed lines, an unknown status and an unknown address were
      each refused without writing anything. The probe ledger was deleted.
- [x] ~~The send mechanism.~~ **Built and tested** —
      `scripts/send-notice.ts`, dry run by default, exercised end to end
      against the local sink: 5 recipients, 5 accepted, re-run skipped all 5,
      reconciliation arithmetic checks out, and `--live` refused when the
      adapter was not the real provider. The test ledger was deleted
      afterwards.
- [ ] **A mail-provider delivery webhook**, which still does not exist. For
      this campaign it is replaced by hand reconciliation (§ 7), which is
      workable at eight recipients and would not be at eighty. It remains the
      thing that would make delivery evidence trustworthy without a person in
      the loop.
- [ ] **Who reads the Resend dashboard**, and when relative to the send. The
      gate does not open until every recipient is recorded, so this is on the
      critical path to activation rather than a tidy-up afterwards.
- [ ] **Someone other than its author reads the email.**

## Confirmed, and no longer open

- [x] **Sentry's region: United States**, from the organisation's Data Storage
      Region setting. Written into both disclosure rows.
- [x] **`privacy@tinycrm.biz` reaches a monitored inbox** — test message sent
      and received.
- [x] **The Terms were checked.** They incorporate the privacy notice, which
      adds the cancellation right above. No separate subprocessor-notification
      duty.
