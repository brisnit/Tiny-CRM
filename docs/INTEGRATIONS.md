# Email and calendar integrations

Phase 1 of connecting Tiny CRM to Gmail, Outlook, Google Calendar and Outlook
Calendar. **This release contains no connector.** It is the schema, the privacy
model, the encryption and the gates the connectors need, plus the fixes to what
was already here and wrong.

Nothing is switched on: the `integrations` flag is off everywhere and no
customer can connect anything when this ships.

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

## 3. Privacy notice: what has to change before any connector ships

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

## 4. Provider console setup — what only you can do

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

## 5. Costs and approval blockers

| Item | Cost | Blocker |
|---|---|---|
| Google Calendar API | No fee | OAuth verification; weeks, not months |
| Microsoft Graph `Mail.Read` / `Calendars.Read` | No fee | Publisher verification needs a Cloud Partner Program account |
| **Gmail read access** | **Annual third-party security assessment** | **Hard blocker for public availability** |

Gmail has no non-restricted read path. Google classifies **both**
`gmail.readonly` and `gmail.metadata` as restricted, so there is no narrower
scope to retreat to. Restricted scopes require verification plus an annual
independent security assessment with a Letter of Assessment, renewed every
twelve months.

Published cost estimates range from roughly $500 to $75,000 and every source
offering a figure sells compliance services, so treat all of them as unreliable;
a quote from an approved assessor is the only real number. Timelines cluster at
six to twelve weeks for a first submission.

Google's API Services User Data Policy says the assessment applies to
"Sensitive and Restricted Scopes", with the requirement depending on the API and
on user counts — so Calendar being exempt is likely but **not confirmed**, and
the consent screen for your own project is where it is confirmed.

That asymmetry is why Gmail is implemented but shipped dark: the other three
connectors need no paid assessment and should not wait behind one.

## 6. Applying this release

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
