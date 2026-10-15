# Email and calendar integrations

## Status: the Phase 1 **foundation**. No connector exists.

This release contains no OAuth flow, no sync worker and no connect button that
does anything. Calling it "Phase 1" would overstate it, so it is named the
foundation and the table below is the honest split.

| Phase 1 deliverable | State |
|---|---|
| OAuth connect / callback / refresh / disconnect, per provider | **Not built.** Prepared for: encrypted token storage, lifecycle columns, the gates |
| Initial (bounded) and incremental sync workers | **Not built.** Prepared for: `syncCursor`, `syncState`, `backfillCompletedAt`, `syncGeneration`, and a durable job runner that already exists |
| Settings UI with connection and error states | **Not built.** The screen is honest about that: both buttons are disabled and say why. `status` vocabulary and `lastError`/`lastErrorAt` columns exist |
| Browser tests exercising a connection and imported records | **Not built.** There is nothing to drive yet |
| Association with contacts, and user correction of associations | **Not built.** The columns exist and always did |
| Per-owner privacy of imported records | **Built**, enforced in the database and the application, tested against the restricted role |
| Imported data excluded from AI | **Built**, tested on the rendered snapshot |
| Encryption of stored credentials | **Built** |
| Workspace- and owner-scoped de-duplication | **Built**, after two wrong answers — see §3 |
| Migration, policies, and a rehearsed procedure | **Built** |

Nothing is switched on: the `integrations` flag is off everywhere.

### Remaining work, as staged PRs

1. **OAuth lifecycle** — authorisation URL with state and PKCE, callback
   validation, token exchange, encrypted persistence, refresh, revocation,
   connect/disconnect/reconnect actions.
2. **Sync workers** — bounded backfill, incremental pass on the cursor,
   pagination, provider rate limits, cursor-invalidation recovery, and
   `syncGeneration` enforcement so a disconnect stops work already claimed.
3. **Settings UI and association** — live connection and error states, the
   imported-record surfaces, and letting a person correct an association or
   share a thread.
4. **Browser and provider verification** — a real browser through the consent
   flow, against a mock provider in CI and against the real provider manually.

---

## 1. What was already here, and what was wrong with it

The models existed — `Integration`, `EmailMessage`, `CalendarEvent`,
`EventAttendee`, with a sync cursor — and the Settings screen said so. Three of
its claims did not survive checking.

**"Credentials have their own encrypted column."** The column existed. The
module the schema named as encrypting it, `src/lib/crypto.ts`, did not exist at
all, and nothing wrote that column anywhere. Now real: AES-256-GCM, versioned
envelope, scrypt-derived key with a purpose-naming salt so an OAuth token is not
encrypted with the same key as a TOTP secret.

**"Both tables carry a unique `(provider, externalId)` constraint … so a worker
can upsert incrementally and re-run safely."** The constraint existed and was
**global across every tenant**. Proven against PostgreSQL before changing it:

```
tenant one inserted the message
tenant two REFUSED: 23505 on EmailMessage_provider_externalId_key
  detail: Key (provider, "externalId")=(gmail, SHARED-EXTERNAL-ID) already exists.
```

This is not an edge case for calendars: one Google Calendar event carries the
**same event id in every invitee's calendar**, so the second customer to sync a
shared meeting would have silently imported nothing. Now
`(workspaceId, provider, externalId)`.

**"The data model is already the real one."** It had no link from an imported row
to the connection that imported it, no owner, no visibility, and no provenance —
so "disconnect stops queued work and handles retained data" had nothing to key
on, and imported mail would have been readable by every teammate.

Two further defects found by inspection rather than from the screen:

- **`Integration` was readable by any workspace member.** It sat in the plain
  workspace-isolation list, so a colleague could read another member's
  connection row — including `credentials`, once tokens live there.
- **Imported mail would have gone straight to a model provider.**
  `buildWorkspaceSnapshot` pulled email subject *and snippet* for every thread
  flagged `needsReply`, and `recommendations` pulled subjects. Both predate any
  connector, so only seeded rows ever flowed — which is exactly why nobody
  noticed. The first real sync would have made it a live disclosure with no code
  change and no review.

## 2. The privacy model

| | |
|---|---|
| A connection belongs to | the person who made it, in one explicitly chosen workspace |
| An imported row starts | **private** — visible to its owner alone |
| It becomes workspace-visible | only when its owner deliberately shares it |
| A teammate with full workspace access sees | nothing of it until then |
| Tiny AI sees | **nothing imported, ever, in this phase** |
| Disconnecting | keeps what was imported and unlinks it; nothing is deleted without being asked |

Enforced in two places, deliberately. `prisma/postgres/016_integration_privacy.sql`
is the database layer — RESTRICTIVE policies, which is the only way to narrow
RLS without accidentally widening it; see `docs/RLS.md`.
`src/lib/integrations/visibility.ts` is the application layer, which is the one
that exists on SQLite and the one that stops a page asking for rows the database
will then filter away.

**Provenance is a column, not a derivation.** `source` is `seed` or `imported`,
written once and never changed. Testing `integrationId IS NULL` instead would
have reclassified a *disconnected* mailbox's mail as ordinary CRM data and
started sending it to a provider — the exact bug the exclusion exists to
prevent.

## 3. De-duplication: three attempts, two of them wrong

The constraint that stops a sync importing the same item twice took three goes,
and the two failures are the useful part.

**Attempt 1 — `(provider, externalId)`.** What was already in the schema, and
global across every tenant. The second *customer* to import a shared item was
refused:

```
tenant two REFUSED: 23505 on EmailMessage_provider_externalId_key
```

**Attempt 2 — `(workspaceId, provider, externalId)`.** Fixed the tenant case and
kept the bug one level in. Two connected colleagues in one workspace, both
invited to the same meeting, collide — because one Google Calendar event carries
**the same event id in every invitee's calendar**:

```
colleague A imported the meeting
colleague B REFUSED: 23505 on CalendarEvent_workspaceId_provider_externalId_key
```

An upsert on that key would have been worse than the refusal: it would have
overwritten A's row and moved its ownership to B.

**Attempt 3 — `(workspaceId, ownerUserId, provider, externalId)`.** Each
connected person gets their own privately-owned copy; re-syncing the same
mailbox still de-duplicates; and ownership cannot be reassigned by an upsert
because it is part of the key.

Why `ownerUserId` and not `integrationId`: disconnecting nulls the connection
link so the customer keeps what they filed, and a key on `integrationId` would
let a reconnect import everything a second time.

Seeded rows have a NULL `ownerUserId`, and NULLs are distinct in a PostgreSQL
unique index, so demonstration data neither de-duplicates against itself nor
collides with anything imported.

**A deliberate consequence worth knowing.** Two attendees who both connect, and
both share the meeting, produce two rows for one meeting. That is correct
storage — a single shared row cannot express per-owner privacy at all — but it
means the display layer will need to collapse them. That belongs with the UI
stage, not here, and it is listed as such.

**What survives a disconnect**, asserted in
`tests/security/integration-privacy.test.ts`: `integrationId` is released,
`source` stays `imported` so the row remains excluded from AI, and
`visibility`/`ownerUserId` stay as they were so it remains private to its owner
and invisible to teammates.

## 4. Privacy notice: what has to change before any connector ships

**No change is needed for this release**, because nothing is imported. The
following must be published *before* the first connector is enabled for any
customer, and this list is the ask, not a decision I have taken:

1. **Categories of data.** The notice currently describes CRM records the
   customer enters. It must add email metadata and message content, calendar
   event details, and attendee names and addresses — including those of **people
   who are not Tiny CRM users**, which is the material change.
2. **Lawful basis and the third-party angle.** Imported correspondence contains
   personal data about the customer's counterparties who never interacted with
   us. The notice should state that the customer is the controller of what they
   import and that Tiny CRM processes it on their instruction.
3. **Sub-processors.** Google and Microsoft are not sub-processors here — we are
   reading *from* them — but the notice should name them as sources. Anthropic
   must **not** need to be named for this data, which is precisely why the AI
   exclusion is a hard rule rather than a setting.
4. **Retention and deletion.** What happens on disconnect, and that imported
   data is kept until the customer removes it. `docs/RETENTION.md` needs the same
   addition.
5. **Google's own requirement.** Restricted-scope apps must disclose in-product
   and in the privacy policy how Google user data is used, and the notice must be
   reachable from the consent screen. This is a condition of passing review, not
   just good practice.

## 5. Provider console setup — what only you can do

These are account-level actions on accounts I have no access to, and each takes
real calendar time. Nothing in this release needs them; the connectors do.

### Google Cloud (Calendar first, Gmail later)

1. Create a Google Cloud project for Tiny CRM.
2. Enable the **Google Calendar API**. Do not enable the Gmail API yet.
3. Configure the OAuth consent screen as **External**, publishing status
   Testing to begin with. Add the privacy policy and terms URLs — `/privacy` and
   `/terms` are already live and suitable.
4. Create an **OAuth 2.0 Client ID** of type *Web application*, with the
   redirect URI `https://tinycrm.biz/api/integrations/google/callback`.
5. Add the scopes `calendar.readonly` and `calendar.events.readonly` and read
   what the console says about their classification — that screen is the
   authoritative answer, and Google's public documentation does not state it.
6. Submit for verification once the connector is ready. Until then, up to 100
   test users can consent.

**Do not paste the client secret into chat.** It goes into Vercel's environment
settings as a secret, or into a hidden local prompt, exactly as the Stripe and
Anthropic keys did.

### Microsoft Entra (Outlook mail and calendar)

1. Register an application in Microsoft Entra ID, **multi-tenant** (accounts in
   any organizational directory).
2. Redirect URI `https://tinycrm.biz/api/integrations/microsoft/callback`.
3. Add the delegated Microsoft Graph permissions `Mail.Read`, `Calendars.Read`
   and `offline_access`. These are ordinary delegated permissions with no paid
   assessment.
4. Complete **publisher verification**. This needs a Microsoft Cloud Partner
   Program account with a Partner One ID, and the verification email's domain
   must match the app's publisher domain. Without it, many customer tenants will
   require an administrator to consent instead of the end user, and some will
   refuse outright.

## 6. Approval requirements: canary versus public

The two cases are genuinely different, and conflating them is what makes Gmail
look like a blocker for everything. Every statement below is from the provider's
own documentation, and anything I could not confirm there is marked
**unconfirmed**.

### Google — a private canary needs no verification at all

Google lists the cases where verification is **not** required, and two of them
apply to us:

- **Internal use.** "The app is only used by people in your Google Workspace or
  Cloud Identity organization", the project is owned by that organization, and
  the consent screen is set to internal. Google states such an app "will not be
  subject to the unverified app screen or the 100-user cap". **No verification
  and no security assessment** — including for Gmail.
- **Development/testing/staging.** "Apps in development/testing/staging mode are
  not subject to verification." The unverified-app screen still appears and the
  100-user cap applies.

There is a sharp edge in the Testing route that affects canary design.
Google: *"Authorizations by a test user will expire seven days from the time of
consent."* The refresh token expires with it. So an External/Testing canary
needs reconsent **weekly** — which would make a long-running sync canary
useless. The Internal route has no such expiry.

**Question for you:** is `artifactdigital.co` on Google Workspace (or Cloud
Identity)? If yes, the canary is an Internal app and Gmail can be canaried
without any assessment. If no, the canary is External/Testing with the 7-day
reconsent, and Gmail realistically waits for the public path.

### Google — public availability

Verification is required for sensitive or restricted scopes, and restricted-scope
apps must **re-verify annually**.

- `gmail.readonly` and `gmail.metadata` are **both restricted** — confirmed on
  Google's Gmail scopes page. There is no narrower read scope to retreat to.
- Google's API Services User Data Policy says apps accessing "Sensitive and
  Restricted Scopes" must pass an annual security assessment and obtain a Letter
  of Assessment, "depending on the API and the number of user grants or users".
- **Unconfirmed:** whether Calendar's `calendar.readonly` /
  `calendar.events.readonly` trigger that assessment. Google's public pages do
  not classify Calendar scopes at all, and the policy wording covers sensitive
  scopes too. **I am not treating Calendar as exempt.** The authoritative answer
  is the scope classification shown on the consent screen of our own project,
  which is why §5 asks you to read and report it.
- **Unconfirmed:** the cost and the timeline. Every figure I found came from a
  vendor selling compliance services, and they disagreed by two orders of
  magnitude. The only real number is a quote from a Google-approved assessor.
  Treat any figure I quoted earlier as hearsay.

### Microsoft — a private canary needs no verification

Publisher verification is, in Microsoft's words, "primarily for developers who
build multitenant apps". A **single-tenant** registration in the Artifact
Digital tenant needs none of it, which makes the Microsoft canary the cheapest
and fastest of the four connectors to stand up.

### Microsoft — public availability

Publisher verification is effectively required, and it is **free**. Microsoft:
"Microsoft doesn't charge developers for publisher verification. No license is
required to become a verified publisher," and "No charges are associated with
completing the prerequisites."

**I overstated this earlier as a cost. It is an account and paperwork
requirement, not a fee.** What it requires:

- a Partner One ID for a verified Microsoft AI Cloud Partner Program account,
  which must be the organisation's Partner Global Account (a *location* Partner
  One ID is explicitly not accepted);
- the app registered with a work or school account, not a Microsoft account;
- a publisher domain set, and **not** `*.onmicrosoft.com`;
- the CPP verification email's domain matching that publisher domain, or a
  DNS-verified custom domain on the tenant;
- the initiating user holding Application Administrator or Cloud Application
  Administrator in Entra **and** CPP Partner Admin or Account Admin in Partner
  Center, signing in with MFA.

Why it matters for public availability rather than being cosmetic: since
November 2020, where risk-based step-up consent is enabled, users **cannot**
consent to newly registered multitenant apps that are not publisher verified
when the app requests permissions beyond basic sign-in from outside its home
tenant. An administrator in each customer tenant would have to consent instead.

Publisher verification is also not supported in national clouds.

### Summary

| | Google Calendar | Outlook mail + calendar | Gmail |
|---|---|---|---|
| **Private canary** | Internal app: nothing. External/Testing: 7-day reconsent | Single-tenant: nothing | Internal app: nothing. Otherwise effectively blocked |
| **Public** | Verification; assessment **unconfirmed** | Publisher verification (free, paperwork) | Verification **+ annual assessment**, cost and timeline unconfirmed |

## 7. Plan availability — proposed, not locked

`emailCalendarSync` is in the code with Pro and the legacy plans set to true.
**It is inert**: the `integrations` flag is off everywhere, so no plan can reach
the feature regardless of this value, and changing the numbers is a one-line
edit with no migration.

I asked about this earlier and recorded "Pro and legacy only" as the answer, but
you have asked for the reasoning before it is locked in, so here it is.

| Plan | Proposed | Why |
|---|---|---|
| **Free** | No | Each connection is a recurring poll against a provider quota shared by every customer. Free is 100 contacts and one workspace; a mailbox sync is an order of magnitude more expensive than anything else Free can do |
| **Plus** | No | The honest reason is commercial, not technical: sync is the strongest reason to move from Plus to Pro, and Plus already gets file uploads as its differentiator |
| **Pro** | Yes | Matches `documentQa`. This is the tier whose buyer is asking for it |
| **Legacy Pro / Lifetime** | Yes | Legacy entitlements have never lost a capability in this product, and taking one away now would be the first time |

Arguments against, which are real:

- **Plus could be the better line.** Sync drives daily engagement, and putting it
  at Pro may suppress adoption enough to hurt both tiers. If the goal is usage
  rather than margin, Plus is defensible.
- **A per-connection limit may beat a plan gate.** "One mailbox on Plus, five on
  Pro" prices the actual cost driver instead of the feature. It needs a limit in
  `PlanLimits` rather than a capability, and it is more code.
- **Gmail's user count feeds Google's assessment thresholds.** Google's policy
  ties the assessment requirement partly to user numbers, so a wider plan gate
  may raise the compliance bar for the one connector that already has the
  highest.

**Nothing locks until you say so.** If you want Plus included, or a
per-connection limit instead, say which and I will change the values before any
connector ships — there is no migration and no data to rewrite.

## 8. Applying this release

```
node scripts/migrate-integrations.mjs            # inspect only, writes nothing
node scripts/migrate-integrations.mjs --apply
```

Hidden prompt for the owner/direct connection, fingerprint refusal, provider
restored in a `finally`, verification by read-back. It applies the migration,
then **`003_deferrable_constraints.sql`**, then `016_integration_privacy.sql`.

**003 is not optional.** This migration adds four foreign keys
(`EmailMessage` and `CalendarEvent`, each to `Integration` and to `User`) and 003
only affects the foreign keys that exist when it runs. Skipping it leaves them
non-deferrable and the deployment gate refuses the next production build — which
is not hypothetical, it blocked the owner-admin panel release for exactly this
reason. Rehearsed: baseline 0 non-deferrable, 4 after the migration, 0 after 003.

The script refuses to apply if `app_user_id()` is absent, because otherwise the
migration is recorded as applied and the policy file then fails partway, leaving
the new columns with no privacy policy over them.

Thirty read-back checks must all pass, including that no credential is stored in
clear and that the `integrations` flag is still off.
