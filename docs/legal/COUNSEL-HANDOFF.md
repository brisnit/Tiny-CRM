# Tiny CRM — legal review handoff

**Prepared for outside counsel.** 5 October 2026.

| | |
|---|---|
| Service | Tiny CRM — a multi-tenant CRM, `tinycrm.biz` |
| Operator | **Artifact Digital LLC**, 178 N. Cuyamaca St., El Cajon, CA 92020, United States |
| Contact for this review | privacy@tinycrm.biz |
| Current status | Pricing and paid subscriptions are **live**. The privacy notice and terms are **not published** — both URLs return 404 today |

## What this document is, and what is being asked

The privacy notice and terms below were written from the software rather than from a
template. Every statement describing how the product behaves has been read from the
source code or verified against a provider's published documentation, and the
evidence is in **Part 5**.

Eight questions remain that the codebase cannot answer, because they are legal
judgements rather than facts about the software. They are flagged inline as
**[Q1 … Q8 — UNRESOLVED]** at the exact point in the text where they bite, and
collected in **Part 1** with proposed wording for each.

**The ask:** confirm or replace the proposed wording for Q1–Q8, and supply the two
figures deliberately left blank — a breach-notification deadline (Q4) and a
liability cap (Q8).

Two notes on how this was prepared, so you can calibrate what to re-check:

- **Nothing here was invented to fill a gap.** Where a figure would have had to be
  guessed, the text says so and asks rather than guessing. The two blanks above are
  the clearest examples; they are not oversights.
- **Business decisions already made by the operator are settled** and are not
  questions for you, though you may of course object to them. They are: no refund
  for unused time on cancellation; 30 days' notice by email before a price or terms
  change; immediate suspension for accounts putting the service or others at risk,
  with notice and an appeal route; no uptime commitment; no data processing
  agreement currently offered; and no company registration or tax identifier
  published.

## How to read the flags

`**[Q4 — UNRESOLVED: breach-notification deadline]**` appears inline in Part 2 or 3
at the place the clause is missing. The same identifier indexes Part 1.

Q6 appears **twice** — once in the privacy notice and once in the terms — because
governing law and jurisdiction must match across both. It is one decision.

## Contents

| Part | |
|---|---|
| 1 | The eight unresolved questions, with proposed wording |
| 2 | Privacy notice — current draft in full |
| 3 | Terms of service — current draft in full |
| 4 | Proposed wording and the reasoning behind each clause |
| 5 | Verified implementation facts, with sources |

---

# Part 1 — The eight unresolved questions

### Q1 — Controller / processor split · privacy §1

**Proposed:** the customer is the controller of the personal data they enter about
their own contacts; Artifact Digital LLC is their processor for that data; and
Artifact Digital LLC is the controller of the customer's own account data (name,
email, password hash, sessions, billing status).

**Needed:** confirmation of the split. **Take this one first** — it determines
whether Q3 and Q5 are needed at all, and whether a DPA could ever be required of
the operator.

### Q2 — Cookie consent · privacy §3

**Proposed:** two cookies are set, both strictly necessary — a session cookie and a
CSRF token. No advertising, analytics or third-party cookies. Therefore no consent
banner is shown.

**Needed:** confirmation of the legal conclusion. The factual inventory is verified
from the code; the question is whether a banner is nonetheless required in any
jurisdiction where the service has users.

### Q3 — International transfer mechanism · privacy §5

**Proposed:** the operator is a US business and the services it relies on store data
in the United States; personal data entered by an EEA, UK or Swiss customer will be
transferred to the United States.

**Needed:** which transfer mechanism applies and what must be said about it. Depends
on Q1. Subprocessor locations are verified (Part 5); one — Cloudflare R2 — publishes
only a broad region, "Western North America", and the text does not claim more.

### Q4 — Breach-notification deadline · privacy §7

**Proposed:** on becoming aware of a personal-data breach affecting a customer's
data, the operator will notify them by email to the account address, describing what
is known, what is being done, and what the customer may need to do.

**Needed — a figure.** No number of hours has been written. Email is the only
notification channel that exists in the product; there is no in-app announcement
mechanism, so any clause premised on in-product notice would be unenforceable today.
A 72-hour figure copied from GDPR's controller-to-regulator obligation would be the
wrong instrument here, which is why it was not used.

### Q5 — Data-subject rights and deadlines · privacy §9

**Proposed:** requests about a customer's own contacts are routed to that customer
and not acted on directly unless the law requires it; requests about account data
are handled by the operator. Two limits are stated honestly: there is no
account-closure function in the product, and deleted data can persist in the
database provider's backups for up to 30 days.

**Needed:** which statutory rights apply and the response deadlines attached. Both
stated limits are verified facts (Part 5).

### Q6 — Governing law and jurisdiction · privacy §12 **and** terms §11

**Proposed:** the laws of the State of California, with exclusive jurisdiction in the
state and federal courts of San Diego County, California.

**Needed:** confirmation or replacement. This was written so there is something to
react to; it is **not** a recommendation. Two reasons to examine it: a business
address does not by itself choose the governing law, and a consumer-facing exclusive
jurisdiction clause is unenforceable in some jurisdictions. One decision, two
appearances — they must match.

### Q7 — Tax registration and collection obligation · terms §4

**Proposed, and now stated as verified fact:** prices are exclusive of tax and **no
tax is currently calculated or collected at checkout**. The amount charged is the
plan price, $10 or $20 a month.

**Needed:** whether the operator has a registration or collection obligation in any
jurisdiction, and from what threshold. Note for context: the Stripe account has
automatic tax enabled for Dashboard-created transactions but **no California tax
registration**, and the application's API-created Checkout Sessions enable neither
automatic tax nor any tax rate — three independent confirmations are in Part 5. The
absence of a registration is a fact, not a conclusion that nothing is owed.

### Q8 — Warranty disclaimer, liability cap and indemnities · terms §9

**Proposed:** the service is provided "as is" and "as available", without warranties
of any kind, express or implied, including merchantability, fitness for a particular
purpose and non-infringement.

**Needed — the limitation of liability, its monetary cap, the exclusion of indirect
and consequential loss, and any indemnity in either direction.** Only the
disclaimer's shape is proposed. A cap decides what a bad day costs the business and
was deliberately not drafted here.

Three verified facts to size a cap against: there is **no uptime commitment and no
SLA**; there is **no independent backup** of customer data; and database
point-in-time recovery is **6 hours**.

---

# Part 2 — Privacy notice, current draft in full

*Section numbering is as it appears on the page. Unresolved items are flagged inline.*

### 1. What Tiny CRM is, and why that shapes this notice

Tiny CRM stores information about **your** contacts, companies, deals, projects and notes. Most of what it holds was typed by you and is about somebody else — a person who is not a user here and has no direct relationship with us. That asymmetry shapes everything below: you decide what goes in, and we handle it on your behalf.

Tiny CRM is operated by **Artifact Digital LLC**, 178 N. Cuyamaca St., El Cajon, CA 92020, United States.

In data-protection terms this most likely makes us a **processor** for the contact data you enter and a **controller** for your own account data. Confirming that split is **[Q1 — UNRESOLVED: controller / processor split]**, and it determines what else this notice must say.


### 2. What is collected

**What you give us**

- Your account: name, email address, password (hashed), time zone, optional job title and avatar.
- Your CRM content: contacts, companies, deals, opportunities, projects, tasks, notes, tags, custom fields, and files you upload.
- Workspace structure: workspace names, members you invite, their roles and record-level access.

**What the service generates**

- Sign-in sessions, with a truncated IP address and a device description, so you can review and revoke them.
- An audit log of security-relevant actions, which is append-only and cannot be edited or deleted by the application.
- Counts of AI model requests per month, used to enforce your plan's allowance.
- Relationship, momentum and health scores, computed locally from the data you entered.

**What is never collected**

- Payment card details. Card data is entered on Stripe's own pages and never reaches our servers. We store only a Stripe customer identifier, your plan, its status and its renewal or end date.
- Advertising or cross-site tracking identifiers. There is no advertising network, no analytics pixel and no third-party tracker.
- Your password in any readable form.


### 3. Cookies

Cookies are used for sign-in and security only: a session cookie, and a cross-site-request-forgery token. There are no advertising or analytics cookies, so there is nothing to opt out of. Whether a consent banner is nonetheless required where you live is **[Q2 — UNRESOLVED: cookie consent]**.


### 4. How information is used

- To run the product: storing and showing you your own data.
- To authenticate you and keep accounts secure, including lockout after repeated failed sign-ins and optional two-factor authentication.
- To enforce plan limits, which requires counting what you have created and how many AI model requests you have used this month.
- To take payment, through Stripe, if you subscribe.
- To send transactional email: verification, password reset, invitations. Not marketing.

Your CRM content is **not** used to train any machine-learning model, ours or anyone else's, and is not sold or shared for advertising.


### 5. Where data goes

Three categories of data leave this deployment, and no others:

The services this deployment relies on:

| Service | Purpose | Processing location |
|---|---|---|
| Vercel | Application hosting | US West (Oregon) |
| Neon | PostgreSQL database | US West (Oregon) — AWS us-west-2 |
| Cloudflare R2 | Storage for uploaded files (bucket `tiny-crm-documents`) | Western North America (WNAM) |
| Anthropic | AI model provider, where AI is enabled | Not pinned to a region |
| Stripe | Payment processing, if you subscribe | United States (Stripe, LLC), primarily |
| Resend | Transactional email only — verification, password reset, invitations | United States (storage) |

Resend delivers through **Amazon SES**, which is Resend's own subprocessor rather than a service we contract with directly. Transactional email carries your name, your email address and a link — never CRM record contents.

Resend stores account data, email metadata and delivery logs in the United States whatever sending region is selected; the sending region affects only where a message is dispatched from. Resend publishes its own subprocessor list and gives at least 14 days' notice before changing it.

Whether international transfer terms are required for your jurisdiction is **[Q3 — UNRESOLVED: international transfer mechanism]**.

**We do not currently offer a data processing agreement.** If you need one, write to privacy@tinycrm.biz and we will tell you where that stands rather than sending a template.


### 6. Artificial intelligence

**AI is controlled per workspace, not per account.** One person may run their own business and a client's in the same account under different obligations, so the setting lives on the workspace.

- **Disabled — nothing leaves.** Relationship scoring, deal momentum, stall detection, project health, duplicate detection, the hygiene scan and the daily brief all keep working. They are computed by the application and never needed a model.
- **Enabled** — a bounded slice of workspace content may be sent to the provider to write prose and answer questions. The amount is capped in code at 16,000 characters per request, including the question and any prior turns; longer context is truncated before it is sent, not after.
- **Private** — reserved for a provider under a zero-retention agreement. It behaves exactly like **Disabled** until an operator asserts that such an agreement exists. It fails closed.

When one request spans several workspaces and any of them has AI disabled, the entire answer is produced locally. The safe direction is chosen deliberately: the alternative would be transmitting one workspace's records because a different workspace allowed it.

**Never sent to a model provider, in any mode:** passwords, session tokens, API keys or any other credential. A contact's email address or phone number is included only when that specific record is the one being summarised.

Only requests that actually reach a paid model count against your monthly allowance. The built-in engine is unmetered on every plan, including Free.

**We hold no zero-retention agreement with the AI provider.** Under the provider's published policy, prompts and responses are deleted from their systems within **30 days** of being received or generated, and retained data is not used to train models without express permission. Content their automated safety systems flag can be kept longer — up to two years. If that matters to you, set the workspace to **Disabled**: nothing is transmitted and every deterministic feature keeps working.

Those are the provider's published terms rather than a commitment we are making on their behalf, and we have not negotiated anything different.


### 7. Security

- Passwords are hashed with bcrypt and never stored in a readable form.
- Workspace isolation is enforced by the database itself through row-level security, not only by application code. A query that arrives without a workspace context returns nothing rather than everything.
- Optional two-factor authentication, with recovery codes.
- Sessions can be revoked individually or all at once, and a password change invalidates existing sessions.
- The audit log is append-only: the application's database role is not permitted to update or delete its rows.
- All traffic is served over HTTPS.

No security claim should be read as a guarantee. Our breach-notification commitments and timelines are **[Q4 — UNRESOLVED: breach-notification deadline]**.


### 8. Retention

**This describes how the service behaves today.** It is a statement of the current implementation, read from the code, and not a commitment to keep anything for any particular length of time. Where something is kept indefinitely that is said plainly below rather than implied away by a general deletion sentence.

Deleted automatically, on a daily sweep

- Expired sessions, and authentication tokens once they have been used or have expired.
- Completed background jobs, 30 days after they finish.
- Expired idempotency keys, and rate-limit counters.
- Security alerts, **365 days after they are acknowledged**. An unacknowledged alert is unfinished work and is kept however old it is. This is separate from the audit log below, which the sweep does not touch.

Not deleted automatically

- **Your business records** — contacts, companies, deals, projects, opportunities, tasks, notes, files — are kept until you delete them. Nothing in the service removes them on a timer.
- **Records you delete go to Trash and stay there.** They remain recoverable by you, and no job empties the Trash, so in practice they are kept indefinitely.
- **Audit records are kept indefinitely** and are deleted by no part of the service. For a security log that is defensible — its value is in covering a period you may need to ask about later — but it is described here as what happens, not offered as a term.

Deleting a workspace

Workspace deletion is scheduled rather than immediate. The workspace becomes read-only for a **7-day** grace period during which the deletion can be cancelled, so an accidental or hostile deletion can be reversed before anything is destroyed. After the grace period it is carried out and cascades to that workspace's records.

Closing an account

There is currently **no way to close an account from inside the product**, so no retention period after closure is being published. Saying that is more useful than printing a period the software cannot carry out. A closure request can be sent to privacy@tinycrm.biz in the meantime. Self-service closure — including the case where you own workspaces that other people are members of, whose data must not be destroyed with yours — is tracked work.

Point-in-time recovery

Our database provider keeps a **6-hour history retention window**, which is the period the database can be restored to an earlier moment within. Practically that is the window in which an accidental or destructive change can be undone at the database level: noticed inside six hours it can be recovered from, and after that it cannot.

**That number is a recovery window, not a deletion guarantee.** It does not mean data is erased six hours after you delete it.

Separately from that window, our database provider keeps its own encrypted backups in cloud object storage and **retains them for 30 days**. So a record you delete is removed from the live database immediately, and can still exist in the provider's backups for up to 30 days afterwards, until it ages out. We cannot reach into those backups to remove an individual record, and no erasure commitment we make can be faster than that window.

Recovery at the **application** level is deliberately longer, and is what you would normally rely on: deleted records stay in Trash, and a workspace deletion is reversible for seven days. Those are described above and do not depend on the six-hour window.


### 9. Your choices

- Export your records as CSV, at any time, without asking us. Six exports exist today — **contacts, companies, deals, projects, opportunities and tasks** — each up to 50,000 rows and covering records that are not in the Trash. Timeline notes, activity history, uploaded files, tags and custom field values are **not** part of an export yet; a complete export is tracked work.
- Turn AI off per workspace, and keep every deterministic feature.
- Review and revoke sessions; enable two-factor authentication.
- Delete records, or a whole workspace.

Requests about data belonging to **your** contacts generally reach you rather than us, because you decide what is stored. How we handle a request that comes to us directly, and the statutory rights that apply, are **[Q5 — UNRESOLVED: data-subject rights and deadlines]**.

Privacy requests go to privacy@tinycrm.biz .


### 10. What is deliberately not claimed

Stating the limits plainly is more useful than implying more than is true:

- No certification is claimed — not SOC 2, not ISO 27001, not HIPAA.
- No zero-retention guarantee from any AI provider.
- No uptime or availability commitment.
- **No independent backup is claimed.** Database recovery has been tested, but what it recovers from is a mistake inside the database within a 6-hour window — it is a copy held by the same provider in the same project, not a separate copy held elsewhere. Account loss or a provider failure is not covered by it. Keeping your own exports is therefore worth doing, and export is always available to you.
- No recovery-time guarantee is offered.


### 11. Children

Tiny CRM is a business tool and is not directed at children.


### 12. Changes and contact

If this notice changes materially we will give at least **30 days' notice by email to your account address** rather than relying on you to re-read it. Email is named deliberately: there is no in-product announcement mechanism, and a notice commitment that depends on one that does not exist would not be kept.

Artifact Digital LLC, 178 N. Cuyamaca St., El Cajon, CA 92020, United States. Contact: privacy@tinycrm.biz . Governing law and jurisdiction: **[Q6 — UNRESOLVED: governing law and jurisdiction]** — a business address is not a choice of law.

---

# Part 3 — Terms of service, current draft in full

*Section numbering is as it appears on the page. Unresolved items are flagged inline.*

### 1. Who these terms are between

These terms are between you and **Artifact Digital LLC**, 178 N. Cuyamaca St., El Cajon, CA 92020, United States (“we”, “us”), covering your use of Tiny CRM.

By creating an account you accept them. If you are accepting on behalf of an organisation, you confirm you are authorised to do so.


### 2. What the service does

Tiny CRM stores and organises contacts, companies, deals, opportunities, projects, tasks and notes, and offers two distinct kinds of assistance:

- A **built-in engine** that computes relationship scores, deal momentum, project health, duplicate detection, hygiene checks and a daily brief. It runs locally, is unmetered on every plan, and needs no AI model.
- **Tiny AI**, which answers open-ended questions in prose using a third-party model. This is metered, because each request costs us money to serve.


### 3. Plans, prices and limits

Prices are in US dollars and billed monthly. Current plans:

| Plan | Price | Contacts | Workspaces | AI answers / month |
|---|---|---|---|---|
| Free | $0 | 100 | 1 | 10 |
| Plus | $10/mo | 2,000 | 3 | 30 |
| Pro | $20/mo | 5,000 | 10 | 60 |

The full set of limits is shown on the pricing page and in your billing settings, where current usage is displayed against each one. Limits are enforced on the server, so the figures you see are the figures that apply.

**Reaching a limit never deletes anything.** It prevents creating more of that thing. If you move to a smaller plan and are above its ceiling, your existing records stay exactly where they are and remain readable, editable and exportable — you simply cannot add more until you are back under it.

Prices and limits may change. Before a change applies to an existing subscription we will give at least **30 days' notice by email to your account address**, and you can cancel before it takes effect — see section 11 .


### 4. Billing, cancellation and refunds

- Payments are processed by Stripe. Card details are entered on Stripe's pages and never reach our servers.
- Paid plans renew monthly until cancelled.
- You can change plan or cancel yourself, at any time, from billing settings.
- Cancelling takes effect at the end of the period you have already paid for. You keep your plan until then.
- If a payment fails we do not remove access immediately: Stripe retries, and your plan is retained while it does. Access ends only once the subscription is finally unpaid or cancelled.
- Changing plan mid-period is prorated by Stripe.

**Cancellation.** If you cancel, no refund or credit is issued for unused time. Your plan continues until the end of the period you have already paid for, and the account then moves to Free.

**Changing plan mid-period is prorated, and the direction matters.** A downgrade produces a credit for the time you did not use at the higher rate. An upgrade produces an additional charge for the remainder of the period. In both cases the adjustment appears on your **next invoice** rather than being charged or refunded immediately.

If you were charged in error, contact us and we will refund it.

**Prices are exclusive of tax, and no tax is currently added.** We do not calculate or collect sales tax or VAT at checkout today, so the amount you are charged is the plan price shown — $10 or $20 a month. If that changes you will get the same notice as any other pricing change: at least 30 days by email.

Whether we are required to register for, or collect, sales tax or VAT in any jurisdiction is **[Q7 — UNRESOLVED: tax registration / collection obligation]**.


### 5. Your data

- Your content remains yours. We claim no ownership of it.
- You can export your records as CSV at any time, without asking us, including after cancelling. Six exports exist today — contacts, companies, deals, projects, opportunities and tasks — each up to 50,000 rows. Timeline notes, activity history, uploaded files, tags and custom field values are not yet part of an export; see the privacy notice.
- Your content is not used to train any machine-learning model.
- How we handle your data is described in the privacy notice, which forms part of these terms.

You are responsible for having a lawful basis to store information about the people you add, and for telling them if that is required where you are.


### 6. Acceptable use

You agree not to:

- Use the service to send unsolicited bulk messages, or to store data obtained unlawfully.
- Attempt to access another account or workspace, or to circumvent plan limits or rate limits.
- Probe, scan or load-test the service without written permission.
- Resell or sublicense the service without an agreement with us.

**Suspension.** If an account puts the service or other customers at risk — through abuse, an attempt to reach another account or workspace, or anything unlawful — we may suspend it **immediately and without advance notice**. We will email the account address explaining the reason, where we are legally permitted to say.

**Appeals.** Write to privacy@tinycrm.biz . We aim to respond within five business days. Suspension is not deletion: your records are not removed, and a suspension that we got wrong is reversible.


### 7. Tiny AI specifically

- AI is controlled per workspace. With AI disabled, no workspace content is sent to any model provider, and every built-in feature keeps working.
- Each plan includes a monthly allowance of model answers. Only requests that reach a paid provider count; the built-in engine never does.
- When the allowance is spent, the built-in engine keeps working and the allowance resets at the start of the next month.
- Model output can be wrong. Check anything you intend to act on; we do not warrant that an answer is accurate.
- We make no zero-retention claim on behalf of the model provider. See the privacy notice.


### 8. Availability

The service is provided as-is, with no uptime commitment and no service-level agreement. Database recovery has been tested, but it recovers from a mistake inside the database within a 6-hour window and is held by the same provider in the same project — it is not an independent backup, and we offer no recovery-time guarantee. Keeping your own exports is therefore sensible, and export is always available to you.

No availability commitment is offered. That is a deliberate choice rather than an omission: a single-region deployment without an on-call rota should not promise a number, and saying so plainly is more useful than silence.


### 9. Warranties and liability

The warranty disclaimer, limitation of liability, indemnities and their caps are **[Q8 — UNRESOLVED: liability cap and indemnities]** — these clauses determine real financial exposure and should not be drafted from a template or by an assistant.


### 10. Ending the agreement

- You may stop using the service at any time, and cancel a paid plan yourself from billing settings.
- You can delete individual records, and whole workspaces. Deleting a workspace is scheduled rather than immediate, so it can be reversed during a 7-day grace period before anything is destroyed.
- **Closing an account is not yet possible from inside the product.** Until it is, a closure request can be sent to privacy@tinycrm.biz . We would rather say this than describe a button that does not exist.
- Export your data before you stop using the service. What an export covers, and what it does not, is set out in the privacy notice.

What is retained after you stop using the service, and for how long, is described in section 8 of the privacy notice — as the service behaves today, rather than as a promised maximum period.


### 11. Changes, law and contact

We will give at least **30 days' notice by email to your account address** before a price increase or a material change to these terms applies to an existing subscription. You can cancel before it takes effect.

Governing law and the courts with jurisdiction are **[Q6 — UNRESOLVED: governing law and jurisdiction]** — a California business address does not by itself choose California law. Contact for legal notices: privacy@tinycrm.biz .

---

# Part 4 — Proposed wording and the reasoning behind each clause

*Reproduced from `docs/legal/PROPOSED-CLAUSES.md` in the repository. Where this and Part 1 differ in emphasis, Part 1 is the summary and this is the detail.*

## Proposed clauses for counsel review

Nine clauses remain unwritten on the two legal pages. This document proposes
wording for each one so review is a redline rather than a blank page.

**How to read it.** Each clause gives the proposed text, the **assumptions** it
rests on, and the **decision** it encodes — because most of these are not purely
legal questions, and the proposed text picks an answer. If an assumption is wrong,
the clause is wrong, and that is the fastest thing for counsel to check first.

**What is not proposed.** Nothing here is a number pulled from a template. Where a
figure would have to be invented — a liability cap, a breach-notification deadline
in hours — the clause says so and asks for the figure rather than guessing one.

Status of the pages: `/privacy` and `/terms` are **not published** (they return 404
in production). The draft banner stays on both until these nine are settled.
Everything describing how the software behaves has been read from the code and is
accurate; see `docs/legal/README.md`.

Facts counsel can rely on without re-deriving them, each verified from the
provider's own published documentation:

| Fact | Source |
|---|---|
| Database backups retained **30 days** in cloud object storage, encrypted (SSE), AES-256 at rest | Neon security overview |
| Our own point-in-time recovery window: **6 hours** | Neon console + plan limits |
| AI prompts and responses deleted within **30 days**; retained data not used for training without express permission; flagged content up to **2 years** | Anthropic commercial retention policy and API data-retention page |
| Transactional email: account data, metadata and logs stored in the **United States** regardless of sending region | Resend regions documentation |
| Payments: Stripe, LLC, **United States** primarily, EEA/UK/Swiss transfers under the Data Privacy Framework | Stripe privacy policy and DPA |
| Hosting: Vercel, **US West (Oregon)**, pinned | `vercel.json` → `regions: ["pdx1"]` |
| File storage: Cloudflare R2, bucket `tiny-crm-documents`, **Western North America (WNAM)** | Cloudflare's own label |

---

### 1. Controller / processor split — privacy §1

> In data-protection terms, you are the **controller** of the personal data you
> enter about your own contacts: you decide what to store about them and why, and
> we have no relationship with those people and never contact them. We are your
> **processor** for that data, and we process it only to provide the service.
>
> For your own account data — your name, email address, password hash, sessions
> and billing status — we are the **controller**, because we decide to collect it
> in order to run the service at all.

**Assumptions.** That a CRM holding a customer's own contacts is the textbook
processor case. That the dual role is acceptable to state plainly rather than
needing a single characterisation.

**Decision encoded.** The split itself. It is the first question because it
determines which of the clauses below the notice needs at all, and whether a DPA
is ever required of us.

---

### 2. Cookie consent — privacy §3

> We set two cookies, both strictly necessary: a session cookie that keeps you
> signed in, and a cross-site-request-forgery token. We set no advertising cookie,
> no analytics cookie, and no third-party cookie, so there is nothing to opt out
> of and no consent banner is shown.

**Assumptions.** The factual inventory is read from the code and is complete — two
cookies, both functional. Counsel should confirm the legal conclusion, not the
inventory.

**Decision encoded.** That we show no banner. The risk is jurisdictional: if a
banner is required somewhere we have users despite the cookies being strictly
necessary, this clause is wrong and we would rather know before publishing than
after.

---

### 3. International transfers — privacy §5

> We are a United States business and the services we rely on store data in the
> United States, with one exception whose location its provider describes only as a
> broad region. If you are in the EEA, the United Kingdom or Switzerland, personal
> data you enter will be transferred to the United States.
>
> **[COUNSEL — transfer mechanism]** Which mechanism applies, and what we must say
> about it, depends on the controller/processor split in clause 1.

**Assumptions.** The subprocessor locations in the table above are accurate. The
exception is Cloudflare R2, which publishes "Western North America" rather than a
country — we do not claim more precision than the provider does.

**Decision encoded.** Only the factual framing. The mechanism is left open on
purpose: Stripe's own transfers run under the Data Privacy Framework and Resend's
under Standard Contractual Clauses, but what *we* owe a data subject is a legal
question and the answer changes with clause 1.

---

### 4. Breach notification — privacy §7

> If we become aware of a personal-data breach affecting your data, we will tell
> you by email to your account address, describing what we know, what we are doing
> about it, and what you may need to do.
>
> **[COUNSEL — deadline]** We have deliberately not written a number of hours
> here. A one-operator service should not promise a notification deadline it has
> not tested, and the statutory deadlines that may apply are not ours to choose.
> Please supply the commitment you consider defensible.

**Assumptions.** Email to the account address is the only notification channel
that exists — there is no in-product announcement mechanism. Any clause premised
on in-app notice would be unenforceable today.

**Decision encoded.** That we commit to the *channel* and the *content* but ask
counsel for the *deadline*. This is the clause most likely to be filled in from a
template with "72 hours"; that figure belongs to GDPR controllers notifying
regulators, and copying it here without deciding whether it applies is exactly the
error this document is trying to avoid.

---

### 5. Data-subject requests and statutory rights — privacy §9

> Requests about data belonging to *your* contacts normally reach you rather than
> us, because you decide what is stored about them. If such a request comes to us
> directly, we will forward it to you and will not act on it ourselves unless the
> law requires us to.
>
> For your own account data, write to privacy@tinycrm.biz. Two limits are worth
> stating honestly rather than discovering later: we cannot currently close an
> account from inside the product, and data you delete can persist in our database
> provider's backups for up to 30 days before it ages out.
>
> **[COUNSEL — which rights apply]** The specific rights, and the response
> deadlines attached to them, follow from clause 1 and from where the requester is.

**Assumptions.** That stating the two operational limits is better than omitting
them. Both are verified: there is no account-closure path in the product, and the
30-day backup retention is Neon's published figure.

**Decision encoded.** That we route contact-data requests to the customer and
handle only account-data requests ourselves. Counsel should confirm that is
available to us under clause 1.

---

### 6. Governing law and jurisdiction — privacy §12 and terms §11

> These terms are governed by the laws of the State of California, and the state
> and federal courts located in San Diego County, California have exclusive
> jurisdiction over any dispute arising from them.
>
> **[COUNSEL — confirm or replace]** This is the obvious choice for a California
> LLC and it is written here so there is something to react to. It is not a
> considered recommendation.

**Assumptions.** Artifact Digital LLC's registered address is in El Cajon, San
Diego County, California.

**Decision encoded.** California law and San Diego County venue. Two reasons to
look at it rather than accept it: a business address is not by itself a choice of
law, and a consumer-facing exclusive-jurisdiction clause is unenforceable in some
jurisdictions, which can make the whole clause worth drafting differently.

---

### 7. Sales tax and VAT — terms §4  *(rewritten against verified behaviour)*

> **Prices are exclusive of tax, and no tax is currently added.** We do not
> calculate or collect sales tax or VAT at checkout today, so the amount you are
> charged is the plan price shown — $10 or $20 a month. If that changes you will
> get the same notice as any other pricing change: at least 30 days by email.
>
> Whether we are required to register for, or collect, sales tax or VAT in any
> jurisdiction is **[COUNSEL]**.

**No longer an assumption — verified.** The earlier draft of this clause said tax
"is added at checkout and shown before you pay", and flagged "Stripe Tax is not
enabled" as the assumption most likely to be falsified by going live. Going live
falsified something else: the Dashboard *does* have automatic tax enabled for
Dashboard-created transactions, but that setting does not reach API-created
Checkout Sessions. Three independent confirmations:

1. `createCheckoutSession` in `src/lib/billing/stripe.ts` passes neither
   `automatic_tax` nor `tax_rates`/`default_tax_rates`.
2. Stripe's Checkout Session reference marks `automatic_tax` **optional**, and a
   session created without it returns `automatic_tax: { enabled: false }` with
   `total_details.amount_tax: 0`. Opting in is explicit.
3. The first live purchase charged exactly **$10.00**, with no tax line.

And independently: the account has **no California tax registration**, so even with
automatic tax enabled Stripe would calculate zero for a California customer. Both
paths reach the same present fact — nothing is collected.

So the clause now states the behaviour as fact, and the counsel marker is narrowed
from "how is tax handled" to the only part that is genuinely legal: **is there a
registration or collection obligation anywhere.**

**Decision still encoded.** Tax-exclusive pricing. Tax-inclusive would be a pricing
decision as much as a legal one and would change what $10 and $20 mean.

**If automatic tax is ever enabled on our sessions, this clause becomes false** —
it is written in the present tense on purpose, so the mismatch is visible rather
than buried.

---

### 8. Warranty disclaimer, liability limit and indemnities — terms §9

> The service is provided "as is" and "as available", without warranties of any
> kind, whether express or implied, including any implied warranty of
> merchantability, fitness for a particular purpose, or non-infringement.
>
> **[COUNSEL — the cap, and both indemnities]** The limitation of liability, its
> monetary cap, the exclusion of indirect and consequential loss, and any
> indemnity in either direction are left unwritten.

**Assumptions.** None. This is the one clause where a template is actively
dangerous.

**Decision encoded.** Only the disclaimer's shape. The conventional cap for a
service at this price is the greater of fees paid in the preceding twelve months
or a small fixed sum — but a cap is the clause that decides what a bad day costs
the business, and an assistant proposing a number for it would be the wrong kind of
helpful. Please supply it.

Worth knowing while drafting it: the service makes **no uptime commitment and no
SLA**, holds **no independent backup** of customer data, and currently has **6
hours** of database point-in-time recovery. Those are the facts a liability cap
should be sized against.

---

### 9. AI output disclaimer — terms §7

Already written and not awaiting counsel, listed here only so the set is complete:
model output can be wrong, we do not warrant that an answer is accurate, and we
make no zero-retention claim on the provider's behalf. The provider's published
retention is now stated as fact in privacy §6 — 30 days, not used for training
without express permission, up to two years for content their safety systems flag.

---

### After review

1. Counsel replaces each **[COUNSEL]** marker and confirms or rewrites the
   proposed text.
2. The nine `NeedsDetail` chips come off the pages as each is settled — **six on
   privacy** (clauses 1, 2, 3, 4, 5, 6) and **three on terms** (clauses 6, 7, 8).
3. The draft banner comes off only when all nine are gone.
4. The routes and the two footer links are restored by the three steps in
   `docs/legal/README.md`.

Until then the pages stay unpublished, which is the state production is in now.

---

# Part 5 — Verified implementation facts

Every statement in the two drafts that describes the software's behaviour comes from
this list. Each row names where it was verified, so counsel can rely on it without
reading the codebase or re-asking.

## Data, storage and retention

| Fact | Source |
|---|---|
| Tenant isolation is enforced by the database, not only by application code: every tenant table has row-level security **enabled and forced**, so a query arriving without a workspace context returns nothing rather than everything | `prisma/postgres/002_row_level_security.sql` |
| Record-level access for restricted members is enforced by database policy rather than by filtering in application code | `prisma/postgres/009`–`011` |
| The audit log is append-only: the application's database role is denied `UPDATE` and `DELETE` on that table | `002_row_level_security.sql` |
| Passwords are hashed with bcrypt and never stored or logged in readable form | `src/lib/actions/auth.ts` |
| Optional two-factor authentication with recovery codes; sessions revocable individually or globally; a password change invalidates sessions minted before it | `src/lib/auth/*` |
| **Point-in-time recovery is 6 hours** — the database provider's free-plan history window | Neon console; `docs/NEON-RECOVERY-DRILL.md` |
| **The provider retains its own encrypted backups for 30 days**, in cloud object storage with versioning. So a deleted record can persist there for up to 30 days after deletion, and an individual record cannot be removed from those backups | Neon security overview: backups "stored in cloud object storage… with versioning enabled", "encrypted using server-side encryption (SSE) and… retained for 30 days" |
| **There is no independent, off-provider copy of customer data.** Provider branching is copy-on-write within one project; it covers an application mistake, not account loss or provider failure | `docs/NEON-RECOVERY-DRILL.md` |
| Deleted records go to Trash and are **never purged automatically** — a 30-day constant exists in the code and is enforced nowhere | `src/lib/workspaces/policy.ts`, verified unreferenced |
| **Audit records are never deleted** by any code path | verified absence of `auditLog.delete` |
| Acknowledged security alerts are deleted **365 days after acknowledgement**; unacknowledged alerts are kept indefinitely | `src/lib/jobs.ts` → `sweep()` |
| Expired sessions, used or expired auth tokens, completed background jobs (30 days), expired idempotency keys and rate-limit counters are deleted on a daily sweep | `sweep()` |
| Workspace deletion is scheduled with a **7-day** cancellable grace period, then cascades to that workspace's records | `WORKSPACE_DELETION_GRACE_DAYS` |
| **There is no account-closure function in the product.** No route, no action | verified absence |
| Customer data export is **six CSV exports** — contacts, companies, deals, projects, opportunities, tasks — each capped at **50,000 rows** and excluding trashed records. Timeline notes, activity history, uploaded files, tags and custom field values have **no export path** | `src/lib/actions/import-export.ts`, `LIMITS.maxExportRows` |

## Subprocessors and locations

| Service | Purpose | Location | How established |
|---|---|---|---|
| Vercel | Application hosting | US West (Oregon) | `vercel.json` pins `regions: ["pdx1"]` |
| Neon | PostgreSQL database | AWS `us-west-2`, US West (Oregon) | Neon console (project region) and the deployed endpoint host, cross-checked |
| Cloudflare R2 | Uploaded file storage, bucket `tiny-crm-documents` | "Western North America (WNAM)" | Cloudflare's own label; R2 publishes a broad region, not a country |
| Resend | Transactional email only | **United States** for stored data | Resend documentation: "all account data, including email metadata, logs, and API records, is stored in the United States"; region selection "does not control where customer data is stored" |
| Amazon SES | Email delivery beneath Resend | — | Resend's own subprocessor, not contracted with directly; identified from message headers |
| Anthropic | AI model inference, only where AI is enabled | Not pinned to a region | No `inference_geo` is set anywhere in the source, so the provider's default routing applies |
| Stripe | Payment processing | United States (Stripe, LLC), primarily | Stripe privacy policy and DPA; some regional localisation exists for particular regimes |

Transactional email carries a name, an email address and a link — never CRM record
contents. Telemetry carries an allowlist of fields and never record contents, note
text, prompts, passwords or tokens.

## Artificial intelligence

| Fact | Source |
|---|---|
| AI is controlled **per workspace**, with a mode that fails closed. With AI disabled nothing is transmitted and every deterministic feature keeps working | `src/lib/ai/privacy.ts` |
| Customer content is **not used to train any model**. No training pipeline exists; model requests are per-request inference only | verified absence |
| The provider deletes inputs and outputs **within 30 days** of receipt or generation | Anthropic commercial retention policy |
| Retained data is "never used for model training without your express permission" | Anthropic API data-retention documentation |
| Content flagged by the provider's automated safety systems may be retained **up to 2 years** | same |
| **No zero-retention agreement is in place** with the provider | operator confirmation |
| Two distinct systems exist: a deterministic built-in engine, unmetered on every plan and requiring no model, and metered model answers. Only requests reaching the paid provider count against an allowance | `src/lib/plans.ts`, `src/lib/entitlements.ts` |

## Billing

| Fact | Source |
|---|---|
| Card details are entered on Stripe's hosted pages and never reach the operator's servers. There is no Stripe code in the browser bundle, asserted by a test that fails if a server-only variable name appears in client code | `tests/security/client-bundle.test.ts` |
| A plan changes **only** on a signature-verified, idempotent Stripe webhook, which re-reads the subscription from Stripe rather than trusting the event payload. A success redirect grants nothing | `src/app/api/billing/stripe/webhook/route.ts` |
| Cancellation is at period end: the plan continues to the end of the paid period, then the account moves to Free. No refund or credit for unused time | portal configuration `subscription_cancel.mode = at_period_end`, `proration_behavior = none` |
| A plan change mid-period is prorated: a **downgrade produces a credit**, an **upgrade an additional charge**, and either appears on the **next invoice** | portal configuration `subscription_update.proration_behavior = create_prorations` |
| A failed payment does not remove access immediately; access ends only when the subscription is finally unpaid or cancelled | `entitlementFor()`, verified with a Stripe test clock through `active → past_due → active` |
| **No tax is calculated or collected at checkout.** Three confirmations: the application's `checkout.sessions.create` call passes neither `automatic_tax` nor any tax rate; Stripe's reference marks `automatic_tax` optional and a session created without it returns `enabled: false` with `amount_tax: 0`; and the first live purchase charged exactly $10.00 with no tax line. The account additionally holds **no California tax registration** | `src/lib/billing/stripe.ts`; Stripe Checkout Session reference; live transaction |
| Prices: Free $0, Plus $10/month, Pro $20/month, USD, monthly only | `src/lib/plans.ts` |

## What is deliberately not claimed

No SOC 2, no ISO 27001, no HIPAA, no penetration-test report, no zero-retention
guarantee from any model provider, **no uptime commitment or SLA**, and **no
independent backup**. Database recovery has been tested, but it recovers from a
mistake inside the database within a 6-hour window and is held by the same provider
in the same project.

## Known gaps in the product that bear on drafting

These are stated because a clause that assumes otherwise could not be honoured:

1. **No account closure.** It does not exist. It also cannot be added naively:
   `Workspace.owner` is declared `onDelete: Cascade`, so deleting an owner would
   destroy every workspace they own — including workspaces other people are members
   of. Closure must transfer ownership or refuse while other members remain.
2. **Trash is never emptied**, so "deleted" customer records persist until the
   customer removes them.
3. **Audit records are never deleted.**
4. **No in-product announcement mechanism exists.** Email to the account address is
   the only channel, which is why the 30-day notice commitment and the breach
   notification clause both name email specifically.
5. **Backups cannot be edited.** An erasure request cannot be satisfied faster than
   the provider's 30-day backup window.
6. A separate, tracked defect: audit entries written by the billing webhook carry
   neither a workspace nor an actor, and the row-level security policy on the audit
   table makes such rows unreadable to the application. The entries exist but cannot
   currently be retrieved. This does not affect the drafts, and is recorded so that
   no clause is written assuming the billing audit trail is retrievable today.

---

## After this review

1. Each **[Q# — UNRESOLVED]** flag is replaced in the page source as it is settled.
2. The draft banner on both pages is removed **only when all eight are settled** —
   not before, and not to make the pages look finished.
3. The two pages are then routed and linked, and published.

Until then both URLs return 404, which is the state production is in now.
