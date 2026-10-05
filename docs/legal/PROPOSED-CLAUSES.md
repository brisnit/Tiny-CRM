# Proposed clauses for counsel review

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

## 1. Controller / processor split — privacy §1

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

## 2. Cookie consent — privacy §3

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

## 3. International transfers — privacy §5

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

## 4. Breach notification — privacy §7

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

## 5. Data-subject requests and statutory rights — privacy §9

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

## 6. Governing law and jurisdiction — privacy §12 and terms §11

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

## 7. Sales tax and VAT — terms §4  *(rewritten against verified behaviour)*

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

## 8. Warranty disclaimer, liability limit and indemnities — terms §9

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

## 9. AI output disclaimer — terms §7

Already written and not awaiting counsel, listed here only so the set is complete:
model output can be wrong, we do not warrant that an answer is accurate, and we
make no zero-retention claim on the provider's behalf. The provider's published
retention is now stated as fact in privacy §6 — 30 days, not used for training
without express permission, up to two years for content their safety systems flag.

---

## After review

1. Counsel replaces each **[COUNSEL]** marker and confirms or rewrites the
   proposed text.
2. The nine `NeedsDetail` chips come off the pages as each is settled — **six on
   privacy** (clauses 1, 2, 3, 4, 5, 6) and **three on terms** (clauses 6, 7, 8).
3. The draft banner comes off only when all nine are gone.
4. The routes and the two footer links are restored by the three steps in
   `docs/legal/README.md`.

Until then the pages stay unpublished, which is the state production is in now.
