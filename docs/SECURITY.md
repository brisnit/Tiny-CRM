# Security

What Tiny CRM actually does, and what it does not.

This document describes implemented behaviour. Where a control is partial or
absent, it says so. It makes no compliance claims: Tiny CRM has not been
audited, certified, or assessed against SOC 2, ISO 27001, HIPAA, GDPR or any
other framework, and nothing here should be read as saying otherwise.

Every claim below names the file that implements it. If a file does not do what
this says, the file is right and this document is wrong — fix both.

---

## 1. Tenancy

Two layers. The application enforces the chain below on every request; PostgreSQL
enforces it again underneath, so a query that forgets the filter still returns
nothing — see `docs/RLS.md` and §16.

**A workspace is the security boundary.** Every record below `Workspace` carries
a `workspaceId`, and the whole authorization model reduces to one chain:

```
authenticated user → workspace membership → permitted resources
```

- `src/lib/auth/context.ts` resolves the session to an `Identity` and re-reads
  the user row on every request, so a deactivated account loses access
  immediately despite holding a structurally valid JWT.
- `src/lib/auth/access.ts` is the only place that grants access:
  - `requireActor()` — authenticated user plus their memberships.
  - `requireWorkspaceAccess(workspaceId, permission)` — a workspace id from a
    request is only ever used to *select* from the caller's own memberships. It
    never widens access.
  - `requireRecordAccess(model, id)` — loads a record with
    `workspaceId IN (caller's workspaces)` in the `WHERE` clause and returns the
    workspace *derived from the record*, so no caller states which workspace an
    operation is "for".
  - `assertRelations(workspaceId, input)` — proves every foreign key in a
    payload belongs to the target workspace before it is written.
- `resolveReadScope(scope)` narrows reads to one workspace or the caller's full
  set. A scope value the caller is not a member of falls back to their own set;
  it can never widen.

**Access failures return "not found", not "forbidden"**
(`noSuchRecord()` in `src/lib/errors.ts`). Confirming that an id exists but
belongs to someone else is itself a disclosure.

**Proof:** `tests/security/tenant-isolation.test.ts` — 33 tests in which a
legitimate member of workspace A substitutes an id from workspace B across
reads, writes, relations, bulk actions, exports, imports, and every AI path.

### The bug class this closes

Before the hardening pass, writes validated the *rows they returned* but never
the *foreign keys they accepted*. A member of workspace A could move their own
deal onto workspace B's pipeline stage, and the deal page then rendered B's
stage name and colour. `assertRelations()` is the fix, and it is called from
every mutating action.

---

## 2. Authentication

`src/auth.ts`, `src/lib/auth/password.ts`, `src/lib/auth/cookies.ts`.

- **Passwords**: bcrypt, cost 12, minimum length 12, maximum 72 bytes (beyond
  which bcrypt truncates and the extra length is a lie about strength). A hash
  stored at a lower cost is transparently upgraded on the next successful
  sign-in (`needsRehash`).
- **Timing**: an unknown email is compared against a real bcrypt hash of a value
  nobody knows (`DUMMY_HASH`), so a wrong address and a wrong password cost the
  same.
- **Enumeration**: sign-in returns one generic message for every failure. Sign-up
  returns the *same* response for a new and an existing address — the duplicate
  simply is not created — so neither endpoint answers "does this email exist?".
- **Lockout**: 8 consecutive failures locks the account for 15 minutes
  (`failedLoginCount`, `lockedUntil` on `User`).
- **Rate limits**: 10 sign-in attempts per address per 15 minutes, 5 per account
  per 15 minutes, 5 sign-ups per address per hour. Both dimensions are needed —
  per-account alone loses to password spraying, per-address alone loses to a
  botnet.
- **Sessions**: JWT, 14-day maximum age, refreshed hourly. Cookies are
  `HttpOnly`, `SameSite=Lax`, and `Secure` in production under the
  `__Secure-` prefix, which browsers refuse to set over HTTP.
- **Audit**: every sign-in outcome — success, failure, lockout — is written to
  `AuditLog`.

**Proof:** `tests/security/auth.test.ts`.

### Password reset

`src/lib/auth/tokens.ts`, `src/lib/actions/auth.ts`.

32 bytes from the CSPRNG; only a SHA-256 hash is stored; 30-minute expiry; single
use through a conditional `updateMany` so two redemptions cannot both win;
superseded when a new link is requested; and on completion **every outstanding
token and every session is revoked**. A reset that left the attacker's session
alive would change the lock while they were already inside.

Every request answers `{ ok: true }` whether or not the account exists, spends
comparable time either way, and is limited on both the address and the account.
Every failure returns one message — "already used" versus "expired" tells an
attacker holding a stale link whether it was ever real.

### Email verification

An unverified account may build its own workspace but cannot invite anyone,
export, import, connect an integration, delete the workspace or touch billing
(`src/lib/auth/verification.ts`). The gate is checked *after* the permission
check, so an under-privileged user is not told that verifying would help.

Enforcement follows the ability to deliver mail: with no provider configured
nobody could verify, so the gate would be a wall. That weakening is deliberate
and reported by the readiness scorecard.

### Sessions

`src/lib/auth/sessions.ts`. Tokens carry a session id matched against a live row
and an epoch compared against the user's. The row is the product feature — sign
out one device — and the epoch is the backstop, making "sign out everywhere",
"password changed" and "account disabled" instant with no lookup at all.

Only the hash of a session id is stored. Addresses are truncated to a /24 or /48
before storage, so a session list can say "somewhere else" without keeping a
movement history. **Settings → Security** lists devices and signs them out.

### Two-factor authentication — foundation only

TOTP with AES-256-GCM-encrypted secrets, ±1 step of drift, replay protection on
the used time step, and bcrypt-hashed single-use recovery codes. All of it works
and is tested.

**It is not demanded at sign-in.** `MFA_ENFORCED_AT_SIGN_IN` is `false`,
`mfaStatus()` returns that flag, the settings screen says so in the UI, and a
test asserts the status a user sees agrees with what sign-in does. A user who
enrols and believes they are protected is in a worse position than one who knows
they are not.

### Not implemented

- **Single sign-on.** `src/lib/auth/context.ts` is the only file that references
  NextAuth, so swapping to Auth.js providers, Clerk, WorkOS or Auth0 is a change
  to one file plus `src/auth.ts`.
- **The MFA sign-in challenge**, as above.

---

## 3. Authorization

`src/lib/auth/permissions.ts` holds the entire role model in one table: 5 roles,
18 permissions, grants written out in full rather than derived by inheritance,
so reading a row tells you exactly what that role can do.

| | viewer | member | manager | admin | owner |
|---|---|---|---|---|---|
| View records | ● | ● | ● | ● | ● |
| Create / edit / archive | | ● | ● | ● | ● |
| Delete permanently | | | ● | ● | ● |
| Export, import | | | ● | ● | ● |
| Pipelines, fields, automations | | | ● | ● | ● |
| Workspace settings, members, audit log | | | | ● | ● |
| Delete workspace, billing | | | | | ● |
| Use / apply AI | | ● | ● | ● | ● |

Rules that are not in the table:

- A role can never be granted at or above the granter's own level, so an admin
  cannot mint an owner (`canAssignRole`).
- The last owner of a workspace cannot be demoted or removed, which would leave
  it with nobody able to delete or bill it.

**UI hiding is not a control.** Components read the same table to decide what to
show, but every rule is enforced server-side inside `workspaceAction()` /
`recordAction()` before the handler body runs. The tests act as each role
directly, bypassing the UI entirely.

**Proof:** `tests/unit/permissions.test.ts` (the matrix, exhaustively),
`tests/security/adversarial.test.ts` (roles enforced against real actions).

---

## 4. The write path

Every mutation is a server action, and **every export of a `"use server"` module
is a callable HTTP endpoint** whether or not the UI ever calls it. They all go
through `src/lib/actions/base.ts`:

```
guard(               ← error boundary; validation failures land here, not in a 500
  workspaceAction/   ← authenticate → membership → permission → rate limit
  recordAction(      ← workspace derived from the record, not from the request
    handler          ← parse → assertRelations → write → audit → emit event
  )
)
```

Guards cannot be forgotten, because they run whether or not the handler asks for
them.

- **Mass assignment**: update schemas `.omit({ workspaceId: true })` and Zod
  strips unknown keys, so `ownerId`, `plan`, `version` and `workspaceId` cannot
  be assigned from a request. Every write names its columns explicitly; there is
  no `data: body` anywhere in the codebase.
- **Concurrency**: `version` travels in the `WHERE` clause, so a concurrent save
  matches zero rows and returns a `conflict` instead of silently overwriting
  someone else's edit.
- **Transactions**: anything touching more than one row — a record plus its
  activity, an approved AI batch, a stage change plus its event — runs in one
  transaction.
- **Destructive actions**: permanent deletion requires the record's name retyped
  *and* verified on the server (`assertConfirmation`), because a dialog is a
  convenience and a direct call to the action would skip it.
- **Soft delete**: every record type archives and restores. Archived records
  leave lists, keep their history, and stop counting against plan limits.
- **Cascades**: the workspace is the only cascade root. Everything below it is
  `onDelete: SetNull`, so deleting a company detaches its timeline rather than
  erasing the account of what happened with it.

**Proof:** `tests/security/adversarial.test.ts`,
`tests/integration/lifecycle.test.ts`.

---

## 5. Input validation

`src/lib/validation/common.ts`, `src/lib/validation/limits.ts`.

TypeScript types are erased at runtime and validate nothing. Zod schemas are the
boundary, and every one of them runs *inside* the error boundary so a rejection
returns a typed `validation` result rather than a 500.

- Ids must match `[A-Za-z0-9_-]{1,64}`, so traversal and injection-shaped
  strings are rejected before reaching a `WHERE` clause.
- URLs accept only `http`/`https`, and the scheme is checked on the **raw**
  value. Checking the normalised form validates a different string from the one
  stored — that is how `file:///etc/passwd` used to pass.
- Text is length-bounded and truncated, never stored unbounded.
- Money rejects `NaN`, `Infinity` and values beyond ±$1,000,000,000; it is
  stored as integer minor units, never floating point.
- Dates outside 1900–2200 are rejected.
- Every list is paginated, page size capped at 100, page number capped at 1000
  so `OFFSET` cannot be driven arbitrarily deep.
- Bulk operations cap at 100 ids; imports at 5,000 rows and 5 MB; exports at
  50,000 rows; AI questions at 4,000 characters and 50 proposals.

`LIMITS` in `src/lib/validation/limits.ts` is the single source of truth for
every bound.

**Proof:** `tests/unit/validation.test.ts`.

---

## 6. Output safety

- **Stored HTML** (note bodies) is sanitised on **write** through an allowlist
  (`src/lib/sanitize.ts`): a fixed tag and attribute set, all `on*` handlers
  stripped, `javascript:`/`data:`/`vbscript:` URLs rejected, comments and
  `<script>`/`<style>`/`<svg>`/`<iframe>`/`<object>`/`<form>` content removed,
  outbound links forced to `rel="noopener noreferrer nofollow"`. Sanitising on
  render alone would leave the payload in the data, where exports, AI context
  and search still meet it.
- **CSV export** neutralises any cell beginning `=`, `+`, `-` or `@` by prefixing
  a tab. Otherwise a contact named `=cmd|'/c calc'!A0` turns an export into code
  execution on the machine of whoever opens it.
- **Uploads** — see §17.
- **Filenames** are stripped of path separators and control characters, and a
  stored file is never named by the browser: `src/lib/uploads.ts` generates a
  workspace-partitioned random storage key.
- **Uploads are disabled in this build** — the `files` flag defaults off and
  `STORAGE_DRIVER=none`. The validation that will gate them exists and is
  tested: an extension allowlist (SVG excluded deliberately — it is an XML
  document that can carry script), magic bytes checked against the declared
  type, size bounds, and `Content-Disposition: attachment` with `nosniff` and a
  `default-src 'none'` CSP on download. There is **no malware scanner**;
  `scanForMalware()` logs its own absence and fails closed when
  `REQUIRE_MALWARE_SCAN` is set.
- **SQL**: every query goes through Prisma with parameter binding. The only raw
  SQL in the application is `SELECT 1` in the health probes.

**Proof:** `tests/unit/content-safety.test.ts`.

---

## 7. AI

`src/lib/ai/`, `src/lib/actions/ai.ts`.

Two properties, both structural rather than prompted:

1. **The model never determines authorization.** The flow is
   *authenticate → authorize → retrieve permitted context → minimise → send*.
   Scope comes from the session before any generation; the model cannot ask for
   a workspace, and nothing it produces is used to select records. A record
   summary is scoped to that record's own workspace, not the caller's whole set.
2. **The model never writes.** Extraction returns *proposals*. Nothing reaches
   the database until a user approves them, and the approval path re-validates
   every id and bounds every value — model output that has round-tripped through
   a browser is untrusted input, not a capability.

**Prompt injection.** Retrieved CRM content is wrapped in `<crm_context>` and
marked `UNTRUSTED DATA` in the system prompt, with the instruction to treat it
as data and never as instructions. Delimiters are stripped from retrieved
content so a hostile record name cannot forge a closing tag. **This is a
mitigation, not the control** — the control is that the model has no write
capability and no influence over retrieval.

**Data minimisation.** Context is a bounded, recent slice (14,000 characters),
not the CRM.

**Logging.** Raw prompts are not logged. AI-applied changes are audited with the
acting user, never with "the AI".

**Provider.** Anthropic by default, OpenAI optional, plus a deterministic
offline engine so the product works with no key configured. Content sent to a
provider leaves the deployment; see `docs/THREAT-MODEL.md`.

**Proof:** `tests/security/ai-boundary.test.ts`.

---

## 8. Transport and headers

`next.config.ts`:

- `Content-Security-Policy` — set per request in `src/proxy.ts` with a **nonce**
  (`src/lib/csp.ts`), because a static `script-src 'self'` blocks Next's own
  inline bootstrap and silently broke React hydration in production. No
  `'unsafe-inline'` and no `'unsafe-eval'` for scripts. `img-src` names two hosts
  rather than all of `https:`. `base-uri 'none'`.

  `style-src-elem` retains `'unsafe-inline'` for one measured reason: `sonner`
  injects its stylesheet from JavaScript after hydration, and a runtime-injected
  element cannot carry a server-generated nonce. `style-src-attr` retains it
  permanently — React and Recharts set style attributes, and no browser supports
  a nonce for an attribute.
- `Strict-Transport-Security` in production (no `preload` — that is a one-way
  door and belongs to whoever owns the domain).
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive
  `Permissions-Policy`.
- `X-Powered-By` removed; `Cache-Control: no-store` on `/api/*`.

**CSRF** is handled by Auth.js's double-submit token on auth routes and by
Next.js's own Server Action origin check on every action.

---

## 9. Rate limiting and abuse

`src/lib/rate-limit.ts` defines 14 named policies (sign-in, sign-up, AI, search,
mutation, bulk, import, export, upload, webhook, …) behind a `RateLimitStore`
interface.

**Three backends**, chosen from configuration (`src/lib/rate-limit/stores.ts`):
in-process for development, Redis/Upstash for production, and a shared counter
table in the application's own PostgreSQL for a deployment that does not want to
operate Redis. The last is the one this repository's tests can verify, and do:
two independent store instances share one counter, and 20 concurrent increments
all land.

**Production refuses to start on the in-process store when `APP_INSTANCES > 1`.**
Counters that are not shared give an attacker N times every limit and reset on
each deploy.

Limits apply on several axes at once, because each alone has a known bypass:
per-account loses to password spraying, per-address loses to a botnet, per-user
loses to a team acting in concert. All configured axes must pass. Export is
capped per workspace as well as per user — an export is the shape an
exfiltration takes, and one seat is not a ceiling on a team.

Identifiers are hashed with a **keyed** digest before storage, so the backend
never becomes a second copy of who uses the product and from where, and someone
holding the key list cannot confirm an email address by rehashing it.

A store outage fails open and logs at error level. That is a deliberate
availability choice; account lockout is an independent control that does not
depend on this store.

---

## 10. Auditing and logging

- `AuditLog` (`src/lib/audit.ts`) is append-only by construction: the module
  exposes a write and a scoped read, and no action offers an update or delete.
  The database cannot enforce that on its own — **production should additionally
  grant the application role `INSERT` and `SELECT` only on this table.**
  Audit entries deliberately outlive the workspace they describe.
- Audited: sign-in outcomes, lockouts, sign-ups, role changes, member removal,
  workspace create/update/delete, record create/update/archive/restore/delete,
  pipeline and field changes, exports and imports with row counts, AI-applied
  changes, plan changes.
- An audit write failure is logged at error level and never fails the user's
  action.
- **Redaction** (`src/lib/logger.ts`) removes values by key name
  (`password`, `secret`, `token`, `api_key`, `authorization`, `cookie`,
  `session`, `credential`, `ssn`, `card`) and by value shape, before anything is
  written, and applies to audit metadata too. Strings are truncated at 2,000
  characters and traversal is depth-limited.
- Every request carries a request id (AsyncLocalStorage), and it appears in both
  the logs and the error returned to the client, so a user's report can be
  correlated without asking them for a screenshot.

**Not logged:** passwords, session tokens, API keys, card data, note or document
contents, raw AI prompts.

---

## 11. Errors

`src/lib/errors.ts`. Everything thrown is normalised to one of eight categories
with a safe message. Stack traces, SQL, ORM internals, filesystem paths, and
provider responses never reach a client — internal detail is logged, and the
client receives a generic message plus a request id.

**Proof:** the error-handling cases in `tests/security/adversarial.test.ts`.

---

## 12. Configuration

`src/lib/env.ts` + `src/instrumentation.ts`. A production server **refuses to
start** if: `AUTH_SECRET` is missing, is the published development value, or is
under 32 characters; `ALLOW_DEMO_AUTH` is enabled; `DATABASE_URL` points at a
SQLite file; `APP_URL` is missing, localhost, or not HTTPS;
`SEED_ALLOW_PRODUCTION` is set; or `TINYCRM_TEST_IDENTITY` is set. Every problem
is reported at once, not one per deploy.

`npm run check:config` runs the same gate as a command, so a pipeline can fail
before traffic is routed.

**Proof:** `tests/security/config.test.ts` — each case launches a real process.

---

## 13. Billing and entitlements

Plan state is written **only** by the verified billing webhook
(`src/app/api/billing/webhook`, `src/lib/billing/webhook.ts`): HMAC-SHA256 over
`timestamp.body`, constant-time comparison, 300-second replay window, and
delivery idempotency through `IdempotencyKey`. There is no browser-reachable
action that changes a plan — a test asserts the absence of one.

`src/lib/entitlements.ts` reads the stored plan and enforces limits server-side
inside the action, after authorization and before the write.

---

## 14. Dependencies

`npm audit` reports **4 high advisories** (`mysql2`, `deepmerge-ts`,
`@prisma/config`, `prisma`).

An earlier version of this document said they were "not part of the deployed
runtime" because the Prisma CLI is a devDependency. **That was half wrong**, and
`npm run audit:deps` now checks rather than asserts: `@prisma/client` is a
*production* dependency and depends on `prisma`, which depends on `mysql2`. All
four are installed by `npm ci --omit=dev` and do ship in a container image.

What is true, and is verified on every CI run: **none of them appears in the
build output**, so none is executed by the running server. The MySQL driver is
never loaded — this app uses SQLite and PostgreSQL — and both advisories against
it require connecting to a hostile MySQL server. No fix exists within Prisma
7.10.0.

The distinction matters and the script reports it as two separate questions:
INSTALLED (on disk) and LOADED (in the build output). CI fails only on the
second, plus any critical advisory in runtime dependencies.

No secrets are committed. `.env*` is git-ignored, the repository history was
scanned for key-shaped literals, and CI runs a secret scan over the full history
on every push.

---

## 15. Reporting a vulnerability

There is no security contact configured for this project yet. Before it takes
real customer data, add one here and in `SECURITY.md` at the repository root,
with a response-time commitment you can actually meet.

---

## 16. Row-level security

PostgreSQL enforces tenant isolation underneath the application. 38 of 47 tables
carry `FORCE ROW LEVEL SECURITY`, gated on two transaction-local settings that
`src/lib/tenant-db.ts` is the only writer of. Unset means **no rows**, so
forgetting the context fails closed.

The invariant: *a query that forgets the application's workspace filter still
returns no other tenant's rows*. Proven by 40 tests that connect directly as the
restricted role — no Prisma, no application code — and issue `SELECT * FROM
"Contact"` with no `WHERE` clause at all, across 16 tables, plus `UPDATE`,
`DELETE`, `INSERT` and audit-log tampering.

**A superuser bypasses RLS even on a `FORCE`'d table.** The application asks the
database which role it is connected as and logs at error level, every boot, when
the connection is not actually protected. Point `DATABASE_URL` at `tinycrm_app`.

Full design, exclusions and failure behaviour: `docs/RLS.md`.

---

## 17. Background jobs

`src/lib/jobs.ts`. Atomic claiming (`FOR UPDATE SKIP LOCKED` on PostgreSQL),
claims that expire so a dead worker strands nothing, exponential backoff with
jitter, a dead-letter state that is never retried automatically, and a
per-attempt execution log.

Every handler runs inside `withTenantContext` for the job's own workspace, so a
background job is subject to the same database-level isolation as a request —
including when the handler forgets to filter. That matters more for jobs than
for requests: nobody is watching one run.

**A worker must actually be running.** Without `npm run worker` somewhere,
automations fire only when a request happens to drain the outbox, and nothing
sweeps expired sessions, tokens, rate-limit counters or scheduled deletions.

---

## 18. AI privacy

Per workspace, not per account (`src/lib/ai/privacy.ts`): one person may run
their own business and a client's in the same account, under different
obligations.

`disabled` sends nothing and keeps every deterministic feature working — scoring,
momentum, stall detection, the cleanup scan, the daily brief. `private` fails
closed until an operator sets `AI_ENTERPRISE_AGREEMENT`; a mode that silently
degraded to `enabled` would send data to a standard endpoint while the workspace
believed otherwise. A mixed scope keeps the whole answer local.

**Nothing claims zero retention.** That is a property of a contract and a
configuration, not of a vendor; the provider table records what is *available*
and never infers what this deployment holds.

---

## 19. Recoverability

- **Trash.** Archived contacts, companies, deals, projects, opportunities and
  notes are listed in one place and restorable. Archive was already reversible;
  without a screen there was nowhere to reverse it from.
- **Workspace deletion is scheduled**, not immediate: a seven-day grace period,
  a `critical` alert, and cancellable throughout. Immediate deletion requires
  having scheduled it first.
- **Backup and restore is verified, not assumed.** `npm run test:backup` backs up
  a representative database, destroys it, restores from the backup alone, and
  checks row counts, a content fingerprint, every foreign key, a
  contact → company → deal → stage → workspace walk, cross-tenant bleed and the
  tenant-isolation suite. It found that a circular foreign key made a logical
  restore impossible; `003_deferrable_constraints.sql` fixes it.

---

## 20. Security alerting

`src/lib/security/alerts.ts`. Deliberately a different type from an audit entry:
the audit log is a complete record of what happened, an alert is the small subset
someone should look at. An alert that fires on everything is an alert nobody
reads.

Repeats collapse into one row with a count, and a repeat re-opens an acknowledged
alert — otherwise an attacker who triggers one alert, waits for it to be
acknowledged and triggers it again would be invisible. Metadata passes through
the same redaction as the audit log. **Without `ALERT_WEBHOOK_URL` nothing is
delivered**; alerts are recorded and logged only.
