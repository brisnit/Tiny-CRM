# Stripe setup

Monthly subscriptions for Plus ($10) and Pro ($20), USD. Test mode first; live
billing is a separate, deliberate step at the end.

Nothing in this document asks you to paste a secret into a chat, a command line,
or a file in the repository. Both scripts prompt for credentials with echo off.

---

## 1. Identify the account

Confirm which Stripe account this is: **Artifact Digital**. Open
<https://dashboard.stripe.com> and check the account name in the top-left
switcher. If the business name differs from what you expect, stop and confirm
before creating anything — prices created in the wrong account have to be
recreated, and subscriptions made against them cannot be moved.

Make sure the **Test mode** toggle (top right) is ON for everything in steps 2–6.

## 2. Create the product and prices

From the repository root:

```bash
node scripts/stripe-sync-prices.mjs
```

It prompts for your **test** secret key (`sk_test_…`); input is hidden. Get it
from **Developers → API keys → Secret key → Reveal** in the dashboard.

The script is idempotent. It finds or creates one product and two monthly prices,
keyed by `lookup_key`, and prints the two price ids. It refuses to touch a live
account unless you also pass `--live`, and it refuses to "fix" an existing price
whose amount differs — Stripe prices are immutable, so changing what customers
pay means creating a new price and deciding what happens to existing
subscriptions.

Copy the two lines it prints:

```
STRIPE_PRICE_PLUS=price_…
STRIPE_PRICE_PRO=price_…
```

Price ids are not secrets.

## 3. Create the webhook endpoint

In the dashboard, still in test mode: **Developers → Webhooks → Add endpoint**.

- **Endpoint URL:** `https://tinycrm.biz/api/billing/stripe/webhook`
- **Events to send** — exactly these six:

| Event | Why it is needed |
|---|---|
| `checkout.session.completed` | Grants the plan after a successful first payment |
| `customer.subscription.created` | The subscription's own creation event |
| `customer.subscription.updated` | Upgrades, downgrades, status changes |
| `customer.subscription.deleted` | Cancellation removes access |
| `invoice.paid` | Clears a past-due state on recovery |
| `invoice.payment_failed` | Marks past due while Stripe retries |

After creating it, click **Reveal** under *Signing secret* and copy the `whsec_…`
value. Each endpoint has its own signing secret, so the test and live values
differ — they are not interchangeable.

## 4. Set the environment variables

**Vercel → `tiny-crm` → Settings → Environment Variables.** For each variable:
*Add New*, set the value, choose the environments, and mark the two secrets as
**Sensitive**.

| Variable | Value | Environments | Sensitive |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` | Production, Preview | **Yes** |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from step 3 | Production, Preview | **Yes** |
| `STRIPE_PRICE_PLUS` | `price_…` from step 2 | Production, Preview | No |
| `STRIPE_PRICE_PRO` | `price_…` from step 2 | Production, Preview | No |

For local development, put the same four in `.env.local` (git-ignored).

**Test and live must never mix.** The deployment derives its mode from the key
prefix rather than from a separate setting, because a `STRIPE_MODE` variable can
disagree with the key and the cost of that disagreement is charging a real card
while believing you are in test mode. A **live** key on a **Preview** deployment
is a boot failure, not a warning — preview builds come from arbitrary branches
and must never be able to charge a card.

Redeploy after setting the variables: they are bound to a deployment at build
time, so an existing deployment will not see them.

## 4b. Order matters when a price id changes

Whenever a price id changes — creating prices for the first time, separating
products, or replacing a price — **update the environment and restart or redeploy
before changing anything in Stripe that customers can act on.**

The reason is a refusal that looks like a bug. `planForPrice` maps an incoming
subscription's price back to a plan using `STRIPE_PRICE_PLUS` /
`STRIPE_PRICE_PRO`. A price the deployment does not know about is deliberately
**not** granted a plan — guessing would be worse — so the webhook verifies, reads
the subscription, logs `unrecognised_price`, and changes nothing. From the
customer's side the upgrade silently does not happen, and nothing in the
application is wrong.

This happened during sandbox setup: Pro's price was replaced, the portal switch
was performed, and the environment still held the old id. Diagnosis was two log
lines, but only because the log says `unrecognised_price` explicitly.

So:

1. Run `stripe-sync-prices.mjs` and note any id marked `(NEW)`.
2. Put the new ids in the environment. **Restart** locally, or **redeploy** on
   Vercel — environment variables bind at boot, so a running server keeps the old
   value.
3. Verify the boot log reports the expected mode, then run
   `stripe-configure-portal.mjs`.
4. Only then switch plans in the portal.

### Reconciling a subscription that was switched too early

Do not set the plan by hand — only a verified webhook may move an entitlement,
and a manual write would leave the stored plan and Stripe disagreeing with no
audit record of why.

A resend does not work either: the event id is already claimed, so it is
correctly deduplicated. Emit a **new** event instead, and let the normal path
apply it:

```bash
stripe subscriptions list --limit 1
stripe subscriptions update <sub_id> -d "metadata[reconciled_at]=$(date -u +%Y%m%dT%H%M%SZ)"
```

A metadata change emits `customer.subscription.updated`. The handler re-reads the
subscription from Stripe, which is authoritative, and applies whatever plan its
current price maps to — so this reconciles the account through exactly the same
verified, idempotent, audited path a real upgrade uses.

## 5. Legacy plans: a three-release rollout

**Do not run the migration before the new pricing deploys.** An earlier version of
this document said to, and it was wrong in a way worth recording.

### Why the obvious orderings both fail

The deployed `planFor` was extracted from the shipped commit and executed against
the values the migration writes:

| Stored value | What the then-deployed code resolved |
|---|---|
| `pro` | Pro — unlimited contacts, 1,000 AI |
| `lifetime` | Lifetime — unlimited, 2,000 AI |
| `legacy_pro` | **Free — 50 contacts, 25 AI** |
| `legacy_lifetime` | **Free — 50 contacts, 25 AI** |

So **migrate-first** strips exactly the accounts the migration exists to protect:
the running code has never heard of `legacy_*` and falls back to Free.

**Deploy-first** is not acceptable either. `lifetime` is handled by the alias in
`PRE_STRIPE_PLAN_ALIASES`, but a stored `pro` would resolve to the *new* Pro's
finite ceilings — unlimited contacts becoming 5,000 — until the migration ran. A
temporary reduction is still a reduction: an account over the new ceiling meets a
refusal, and "we restored it a few minutes later" is not continuity of service.

### The rollout that preserves entitlements continuously

Three releases, expand then migrate then contract. No account's entitlements
change at any point.

**Release A — preparatory.** Teaches the code the new ids while leaving the old
ones meaning exactly what they mean today:

- `pro` keeps its current unlimited limits
- `lifetime` keeps its current unlimited limits
- `legacy_pro` and `legacy_lifetime` are added, **identical** to the above
- no `plus`, no new Pro, no pricing-page change

Before the migration a row reads `pro` and resolves to unlimited. After it reads
`legacy_pro` and resolves to unlimited. The two are indistinguishable from the
account's side, which is the property that makes the migration safe to run.

**Migration.** `scripts/migrate-legacy-plans.mjs --apply`, with Release A serving.
Rewrites `pro` → `legacy_pro` and `lifetime` → `legacy_lifetime`. Reversible with
`--revert`.

**Release B — the new pricing.** `free` / `plus` / `pro` (the $20 tier) plus the
two legacy plans. Redefining `pro` is safe now because no row holds it.

### Rollback

Release A is the rollback target for Release B, and it must stay deployable for as
long as any `legacy_*` row exists — rolling back past it, to a build that predates
the legacy ids, would send those accounts to Free. Note this explicitly in the
release notes rather than relying on nobody doing it.

### The order of operations

```bash
# 1. Read-only. Decides whether any of this is needed at all.
node scripts/plan-usage-audit.mjs
```

If it reports **no** `pro` or `lifetime` rows, there is nothing to migrate and
Release B can ship directly — the three-release dance exists only for accounts
that hold the old ids.

If it reports any, ship Release A, then:

```bash
node scripts/migrate-legacy-plans.mjs            # dry run, rehearsed and rolled back
node scripts/migrate-legacy-plans.mjs --apply
node scripts/plan-usage-audit.mjs                # confirm no old ids remain
```

Then ship Release B.

Both scripts prompt for the production connection string with echo off. The audit
runs entirely inside a `READ ONLY` transaction; the migration is one transaction.

### The `lifetime` alias

`PRE_STRIPE_PLAN_ALIASES` maps `lifetime` → `legacy_lifetime` so that a stored old
id is never resolved to Free by a newer build. **Keep it** until the audit confirms
no old ids remain *and* the rollback question above has been settled. It is cheap
insurance against an ordering mistake, and the thing it protects against is a
paying account silently losing access.

`pro` is deliberately **not** aliased: it means two different things either side of
this change, and aliasing it would hand unlimited records to every future Pro
subscriber. That is why `pro` needs the migration rather than an alias.

## 6. Verify in test mode

With the test key live on the deployment:

1. **Checkout.** Settings → Plan & billing → *Get Plus*. Use card
   `4242 4242 4242 4242`, any future expiry, any CVC. You should land back on the
   billing page and the plan should read Plus within a few seconds.
2. **Webhook delivery.** Dashboard → Webhooks → your endpoint → *Events*. Each
   delivery should be `200`. A `401` means the signing secret does not match.
3. **The plan came from the webhook, not the redirect.** Visit
   `/settings/billing?checkout=complete` directly while on Free. It must still
   show Free — the parameter only changes a line of copy.
4. **Upgrade and downgrade.** *Manage payment method and invoices* → change plan
   to Pro, then back. Limits should follow in both directions.
5. **Failed payment.** Use `4000 0000 0000 0341` (attaches, then fails). The
   account should show "last payment did not go through" and keep its plan —
   access ends only when Stripe gives up.
6. **Cancellation.** Cancel in the portal. The plan should fall to Free, and no
   records should be deleted.
7. **Replay.** In the dashboard, resend any delivered event. The response should
   report `deduped: true` and nothing should change.

## 7. Going live — not yet

Only after the test-mode run above is signed off:

1. Switch the dashboard to live mode and re-run
   `node scripts/stripe-sync-prices.mjs --live` to create the live prices.
2. Create a **separate** live webhook endpoint at the same URL and copy its own
   signing secret.
3. In Vercel, change `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_PLUS` and `STRIPE_PRICE_PRO` to the live values **for Production
   only**. Leave Preview on the test values.
4. Redeploy and confirm the boot log reports `"stripe":"live"`.
5. Make one real purchase with a real card, confirm the plan applies, then refund
   it from the dashboard.
