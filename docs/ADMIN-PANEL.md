# Owner-admin panel

A read-mostly view of every account, with four mutations: grant, change and
revoke complimentary access, and suspend or reinstate an account. It is
reachable only by the platform owner.

What it deliberately does **not** do: charges, refunds, subscription
cancellation, paid plan switching, impersonation, and permanent account
deletion. The first four belong to Stripe and are linked to rather than
rebuilt; the last two are not in this version.

---

## 1. Authorization

Access is a row in `PlatformAdmin`, keyed by **user id**. Two conditions must
both hold: the session's user id has a row, and the account's current email
matches the `boundEmail` recorded when the row was written.

**The user id is the binding.** The row is found by id, so the address cannot
transfer administration to anybody: an account that later takes that address
is a different account with a different id, and the lookup simply misses. The
second condition can therefore only ever **deny** — it never grants.

What it catches is a mis-bound id: a real account, the wrong one, silently
holding the panel because a character was wrong when the row was written.
From inside the product that is otherwise undetectable.

The cost is explicit: **if the owner changes their email, the panel stops
working** until an operator re-binds with
`scripts/bind-platform-admin.mjs`. That is the safer of the two failures, the
refusal names the mismatch in the server log, and
`bind-platform-admin.mjs` flags the drift when it lists administrators.

`boundEmail` is read from the account at bind time, not typed at the prompt —
an operator-supplied address would agree with the wrong id just as readily as
the right one.

It is a table and not an environment variable because the row-level-security
policy that lets an admin read across tenants must consult the same fact, and a
policy cannot read `process.env`. One source of truth, consulted by both.

**Every page, action and route checks for itself.** `src/app/(app)/admin/layout.tsx`
checks too, but that is a convenience: a layout does not run for a server
action, and an action is reachable by POST whether or not any page rendered.

Refusals are `not_found`, not `forbidden`. Confirming that an administrative
surface exists is itself a disclosure.

### What the model does and does not protect against

`app.user_id` is **trusted application context**. It is written only by
`withTenantContext`, from an identity already resolved from a validated
session, and no customer-facing surface sets it from request data.

It is **not** protection against arbitrary SQL execution. Anything able to run
statements as `tinycrm_app` — a SQL injection, a leaked credential, a shell on
the server — can `SET app.user_id` to an existing administrator's id and be
treated as that administrator. No write is required and `PlatformAdmin` does
not prevent it. This is true of every policy in the schema, because all of them
read the same setting. RLS isolates tenants from each other *through* the
application; it is not a second line of defence behind the application being
compromised.

What `PlatformAdmin` does prevent is the **appointment of a new administrator
at runtime**. The table has RLS with a single `FOR SELECT` policy admitting
only your own row, and no INSERT, UPDATE or DELETE policy at all — so
membership cannot be created through the application role by any means,
including by application code. Administration is established by migration. An
attacker at that level can impersonate an admin who exists; they cannot mint
one.

---

## 2. Complimentary access and Stripe

### A grant is never written to `User.plan`

That column belongs to the Stripe webhook, which rewrites it on every
subscription event. A grant written there would be silently erased the next
time Stripe said anything.

Grants live in `PlanGrant`. Two requirements then hold by construction rather
than by vigilance:

- a verified webhook cannot erase a valid grant — different row;
- revoking a grant restores the underlying entitlement, because the underlying
  entitlement was never touched. There is no restore step to fail.

### The effective entitlement

```
effective = combinePlans(underlying, granted)
```

- `underlying` is `User.plan` with pre-Stripe aliases resolved (`lifetime` →
  `legacy_lifetime`).
- `granted` is the strongest grant in force.
- Whichever is the **superset** wins, so a grant can only ever add.

Legacy is protected structurally: `combinePlans` short-circuits on
`isLegacyPlan` before any comparison, so no future reordering of ranks can
erode a Lifetime account. Lifetime is not grantable at all — `GRANTABLE_PLANS`
is `plus` and `pro`.

This selects between existing `PLANS` entries. It introduces no limits of its
own; there is one plan system and this chooses a member of it.

### Expiry is resolved on read

`activeGrantWhere()` compares `expiresAt` in the query that loads the grant. A
lapsed grant stops applying the instant it lapses. There is no sweeper to
schedule, fail quietly, or forget on a new environment, and no window in which
a dead grant is still honoured because a job has not run.

### Where it is resolved

Resolving inside `getIdentity()` alone would not have been enough. Three checks
read a **workspace owner's** plan, because the owner is who pays:

| Call site | Reads |
|---|---|
| `getIdentity()` | the acting user — covers all 12 `planFor()` call sites |
| `fileUploadsIncluded` | the workspace owner |
| `documentQaEntitled` | the workspace owner |
| `seatUsage` | the workspace owner |

All four go through `effectiveFrom()`.

### What the UI shows

Three separate facts, never merged: **billing** (the stored column — the only
one that corresponds to money), **Complimentary** (the grant, with its expiry),
and **Effective** (what capabilities resolve from, shown only when it differs).
The dialogs state plainly that a grant creates no subscription and charges
nothing, and that suspension cancels nothing and refunds nothing.

The billing badge reads **`Paid: <plan>`** only for a purchasable plan with a
Stripe customer and the stored status `active`. Everything else reads
**`Underlying: <plan>`** with the stored status shown as its own badge beside
it. `trialing`, `past_due` and `canceling` are all in that second group, and
`canceling` is the one worth spelling out: it is not a Stripe status but a
value this codebase writes for *either* `active` *or* `trialing` once an end is
scheduled, so nothing stored distinguishes a paid period running out from a
trial cancelled before it ever billed. "Paid" would assert a collected payment
for a customer who has never been charged. A legacy entitlement reads
**`Legacy: <plan>`**, because nobody is billed for one.

A grant that is live but currently adds nothing is labelled **"No additional
access currently"** — not "inactive". The grant *is* active: it is stored, it
still expires on its date, and it resumes adding access the moment the
account's own plan drops below it. Its expiry stays on screen throughout, which
is the whole point: an operator needs that date in advance, and hiding it until
it mattered would hide it while there was still time to act.

---

## 3. Suspension

Setting `User.deactivatedAt`, which already existed and is already checked on
every request: `getIdentity()` re-reads it and returns `null`, so an existing
session stops working immediately rather than at next sign-in. `sessionEpoch`
is bumped as well, invalidating every issued token outright.

A reason is required and stored in `deactivatedReason`, so the panel can say
why without reconstructing it from history.

**Suspension does not touch Stripe.** A suspended account that is paying keeps
paying. Cancel or refund in Stripe separately.

The admin cannot suspend their own account — refused by the server, not merely
hidden in the UI.

### Account deletion, and the `Workspace.owner` cascade

Not implemented, deliberately. `Workspace.ownerId` is a required relation and
`User` deletion cascades to `ownedWorkspaces`, which cascades onward to every
record in them. Deleting an account that owns a workspace with colleagues in it
would therefore delete **their** data too, silently. Any future deletion feature
has to decide ownership transfer first; suspension covers the operational need
without that question.

---

## 4. Audit

Every administrative mutation and its audit entry are written in **one
transaction**. An entitlement change that succeeded while its record failed is
an unexplained change to someone's access; an audit entry whose mutation rolled
back records something that never happened.

`recordAudit` is best-effort by default — an audit failure must never be why
somebody cannot sign in — so these four actions pass `required: true`, which
rethrows and takes the mutation with it. Covered by
`tests/security/admin-audit-atomicity.test.ts`, which makes the INSERT fail
with a trigger and then checks the row.

Entries are written with `actorId` = the admin and `workspaceId` = **null**.
The existing `AuditLog` policy reads an orphaned row only for the actor who
wrote it, so the administrative trail is visible to the admin who made it
without widening the policy for anyone. The customer is carried in `entityId`
and the metadata, as data rather than as a tenancy claim.

### The known billing-audit visibility defect

Rows written by the Stripe webhook carry **neither** `actorId` nor
`workspaceId`, and under the policy above are therefore invisible to everyone.
This panel does not fix that. Widening the predicate to reach them would expose
every service-written row to whatever the new predicate admitted — a larger
hole than the one it closes, on the one table whose purpose is recording what
happened.

The administrative history panel says so on screen rather than appearing
complete.

---

## 5. Schema and RLS changes

| Change | Why |
|---|---|
| `PlatformAdmin` table | Authorization that an RLS policy can consult. |
| `PlanGrant` table | Complimentary access kept out of the column Stripe owns. |
| `User.deactivatedReason` | Current suspension reason, without replaying history. |
| `platform_admin_sees_self` on `PlatformAdmin` | The application's own check must be able to read its row. **Only** your own row; no write policy at all. |
| `platform_admin_reads` on `Workspace`, `WorkspaceMember` | `FOR SELECT` only, so the panel can show ownership and membership. |
| `app_is_platform_admin()` | SECURITY DEFINER, `search_path` pinned to `pg_catalog, public`, fully qualified names. |

All additive. No existing column, policy or row is altered, and no data is
backfilled. With no row in `PlatformAdmin`, every predicate is false and the
pre-existing policies decide exactly as they did before.

---

## 6. Applying this to production

Nothing below has been run. In this order:

**1. Resolve the owner's user id.** Read-only, hidden prompt, no credentials in
a terminal history:

```
node scripts/resolve-admin-user.mjs hello@artifactdigital.co
```

It prints the id, the account's plan and whether it is already an admin. If the
address does not resolve to exactly one account, **stop** — binding the wrong
id is the failure this step exists to prevent.

**2. Apply the migration and the policies — one command.**

```
node scripts/migrate-admin-panel.mjs            # inspect only, changes nothing
node scripts/migrate-admin-panel.mjs --apply
```

It prompts for the **owner/direct** connection with hidden input, refuses any
database whose fingerprint is not a known production one, and notes if you
have given it the pooled endpoint instead.

With `--apply` it switches the local schema to `postgresql`, regenerates,
runs `prisma migrate deploy`, applies
`prisma/postgres/015_platform_admin_policies.sql`, and then **restores the
local schema to `sqlite` and regenerates again in a `finally`** — with a
byte-for-byte restore as a backstop. An interrupted run leaving the provider
on `postgresql` is a trap for the next local command, and it has happened in
this repository.

Verification is a read-back, before and after, not an exit code:

- the migration appears exactly once, finished and not rolled back;
- `PlatformAdmin` and `PlanGrant` exist, and `User.deactivatedReason` does;
- `PlatformAdmin` has RLS **enabled and FORCEd**;
- all three policies exist, every one of them is `SELECT`-only, and
  `PlatformAdmin` has **no** write policy;
- `app_is_platform_admin()` is SECURITY DEFINER with a pinned `search_path`;
- **no administrator is bound** — binding is a separate step.

The connection is never read from the environment and never passed in argv,
where `ps` would show it.

**3. Bind administration to the owner's id.**

```
node scripts/bind-platform-admin.mjs <user-id>
```

Hidden prompt for the owner/direct connection, same fingerprint refusal. It
prints the administrators before and after, and takes an **id** — the binding
is the id, not an address.

It also **refuses any account whose address is not `hello@artifactdigital.co`**
(`scripts/lib/owner-binding.mjs`). The id is still the binding; the address can
only ever deny. What it catches is a correctly typed id for the *wrong*
account — a real customer, silently holding the panel, with every other
verification passing because the id resolved to somebody. Re-typing the address
at the confirmation prompt cannot catch that: it only proves the operator can
read the line above it.

Consequences worth knowing before you run it:

- changing the owner's email later **locks the panel** until it is re-bound,
  because the stored `boundEmail` no longer matches. There is no override flag;
  a different address is a reviewed change to `OWNER_ADMIN_EMAIL`.
- `--unbind` deliberately skips the address, suspension and single-administrator
  rules. Each exists to stop administration being created in the wrong place,
  and each would otherwise block the recovery from having done so.

**4. Deploy.** Ordinary push to `main`.

Run steps 2 and 3 **before** the push. Production applies migrations ahead of
the deployment, and the deployment gate blocks a push whose migrations are not
yet applied.

**5. Verify.** Sign in as the owner: the Admin link appears. Sign in as any
other account: it does not, and `/admin` is a 404.

### Rollback

```
node scripts/bind-platform-admin.mjs --unbind <user-id>
```

The panel becomes unreachable immediately — every check reads the table. The
tables and policies can stay; with no row they do nothing. Dropping the two
`FOR SELECT` policies restores the previous behaviour exactly.

Grants already made are unaffected by unbinding, and remain honoured. To end
one, revoke it in the panel first.
