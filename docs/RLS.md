# Row-level security

Tenant isolation enforced by PostgreSQL, underneath the application.

Application-level isolation (`src/lib/auth/access.ts`) remains the primary
control and is unchanged. This is the second layer, for the case that layer
cannot cover.

---

## The invariant

> A query that forgets the application's workspace filter still returns no other
> tenant's rows.

The first layer is good code with a single chokepoint, and it is still code. A
raw query written outside the helpers, a background job added next year, an ORM
call by someone who did not read `access.ts`, or a SQL-injection foothold that
survives parameterisation — each of those bypasses it and none of them bypasses
this.

**Proof:** `tests/security/rls.test.ts`, 40 tests. They connect to PostgreSQL
directly as the restricted role, with no Prisma and no application code in the
path, and issue the queries a careless developer or an attacker would:
`SELECT * FROM "Contact"` with no `WHERE` clause at all, across 16 tables, plus
`UPDATE`, `DELETE`, `INSERT`, and attempts to tamper with the audit log.

---

## How tenant context is established

Two transaction-local settings:

| Setting | Meaning |
|---|---|
| `app.workspace_ids` | Comma-separated workspaces this transaction may see |
| `app.user_id` | The acting user, for tables scoped to a person |

Set with `set_config(name, value, true)` — the function form of `SET LOCAL` — so
the value can be a bound parameter rather than interpolated SQL.
`src/lib/tenant-db.ts` is the only place either is written.

### Why transaction-local, and not session-level

A pooled connection is reused across requests. A session-scoped `SET` would leave
one tenant's context on the connection for whoever is handed it next — a
cross-tenant leak created by the very mechanism meant to prevent one. `SET LOCAL`
is discarded at `COMMIT` or `ROLLBACK`, so context cannot outlive the transaction
that established it.

A test asserts exactly this: after `withTenantContext` returns, reading
`current_setting('app.workspace_ids', true)` on the same client yields nothing.

This also means the design is safe under transaction-mode connection pooling
(PgBouncer), which session-level settings and session advisory locks are not.

### Unset means no rows

```sql
CREATE FUNCTION app_can_see_workspace(candidate text) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT candidate = ANY(app_workspace_ids())
  $$;
```

`app_workspace_ids()` returns `NULL` when the setting is empty or absent.
`x = ANY(NULL)` is `NULL`, and `NULL` is not `TRUE`, so the row is filtered out.
**Forgetting to set the context fails closed**, immediately and completely,
rather than silently returning everything.

The deny-by-default behaviour lives in one function rather than being re-derived
in forty policies.

### Where the ids come from

From the caller's own memberships, resolved by `requireActor()` — never from a
request. `withTenantContext` additionally rejects any id that is not
`[A-Za-z0-9_-]{1,64}`, so the value reaching `set_config` cannot contain the
comma the setting is split on.

The policy trusts that list. The control against a forged list is that the value
never comes from a request, which is the same property the first layer relies on.

---

## Roles

| Role | RLS applies | Used for |
|---|---|---|
| `tinycrm_app` | **Yes** | The request path and the worker. `NOBYPASSRLS`, `NOSUPERUSER`, not the table owner. |
| The owner role | Yes — `FORCE` binds it | Migrations and maintenance |
| Any superuser | **No** | Nothing, in production |

### A superuser bypasses RLS, and this is the most likely way to get it wrong

`FORCE ROW LEVEL SECURITY` binds the table owner. It does **not** bind a
superuser. Measured on the verification cluster:

```
SELECT count(*) FROM "Contact"   -- as the bootstrap superuser:  9
SELECT count(*) FROM "Contact"   -- as tinycrm_app:              0
```

A deployment that connects as a superuser has the policies fully installed and no
second layer at all, with nothing to indicate it.

So the application asks rather than assumes. `rlsStatus()` in
`src/lib/tenant-db.ts` queries `current_user`, `pg_roles.rolsuper`, table
ownership and the count of `FORCE`'d tables, and `src/instrumentation.ts` logs on
every boot:

```
INFO   row-level security active   { role: "tinycrm_app", tables: 42 }
ERROR  row-level security is NOT protecting this connection
       { reason: 'Connected as "tinycrm", which is a superuser. A superuser
                  bypasses row-level security even on a FORCE'd table.' }
```

It warns rather than throws: a missing second layer must not take down a
deployment whose first layer is intact. But it says so at error level, every
boot, until it is fixed.

The RLS test suite asserts the test connection is neither a superuser nor a table
owner **before** anything else — otherwise every test below it would pass
vacuously.

---

## Which tables use RLS

**42 tables under `ENABLE` + `FORCE ROW LEVEL SECURITY`.**

### Directly scoped — a `NOT NULL workspaceId`

`WorkspaceMember`, `Company`, `Contact`, `ProjectStatus`, `Project`, `Pipeline`,
`Deal`, `Opportunity`, `Task`, `Note`, `Activity`, `FileAsset`, `Tag`, `TagLink`,
`CustomFieldDef`, `CustomFieldValue`, `Automation`, `AiThread`, `Integration`,
`EmailMessage`, `CalendarEvent`, `DomainEvent`

```sql
CREATE POLICY tenant_isolation ON "Contact"
  USING (app_can_see_workspace("workspaceId"))
  WITH CHECK (app_can_see_workspace("workspaceId"));
```

`USING` gates what is readable and what an `UPDATE`/`DELETE` may target.
`WITH CHECK` gates what may be written — without it a caller could insert a row
into, or move a row to, a workspace it cannot read. Both halves are tested.

### `Workspace` itself

Gated on the context list, so a workspace row is visible exactly when the caller
holds it in context.

### Indirectly scoped — reached through a parent

`Milestone`, `PipelineStage`, `ProjectContact`, `DealContact`,
`OpportunityContact`, `AutomationRun`, `AiMessage`, `EventAttendee`, `JobRun`

```sql
CREATE POLICY tenant_isolation ON "PipelineStage"
  USING (EXISTS (SELECT 1 FROM "Pipeline" p
                 WHERE p.id = "pipelineId" AND app_can_see_workspace(p."workspaceId")));
```

The subquery reads a table that is itself protected, so a row whose parent is
invisible is invisible too.

### Person-scoped — `SavedView`, `Notification`

Gated on `app.user_id` **and** the workspace when one is set. A saved view belongs
to a person, not to a workspace, and a workspace filter alone would show one
colleague another's.

### Nullable-workspace — `AiInsight`, `AuditLog`, `SecurityAlert`, `FeatureFlag`

A `NULL` workspace means "not tied to one", and each needs its own answer:

- **`AuditLog`** — a row with no workspace is written deliberately when a
  workspace is deleted: the record of the deletion has to outlive the thing
  deleted. It is visible only to the actor who performed the action.

  *The first version of this policy made those rows readable by any authenticated
  connection*, on the reasoning that they carry "no tenant data beyond a name".
  That was wrong — the summary names the workspace and the row carries
  `actorEmail`. The test suite caught it before it shipped.

- **`SecurityAlert`** — same shape, same reason. "Someone exported everything
  from Acme" must not become readable by every other tenant.

- **`AiInsight`** — account-level briefs have no workspace; workspace-scoped
  insights are gated normally.

- **`FeatureFlag`** — configuration, not customer data. A global row is readable
  by anyone, which is what makes a flag evaluable before a workspace is known.

---

## Which tables intentionally do not

Nine, each because it is read **before any workspace context can exist**. A
policy on these would deny the very lookup that establishes the context.

| Table | Why |
|---|---|
| `User` | Sign-in reads a user row with no context to set. Contains no tenant data; the application never exposes another user's row. |
| `AuthToken` | Reset and verification tokens, looked up by hash before a session exists. |
| `UserSession` | Read on every request to decide whether a session is still live — necessarily before a workspace, and for a user who may belong to none. Every query filters on `userId` (`src/lib/auth/sessions.ts`). |
| `MfaCredential` | Read while authenticating. Holds an encrypted secret, no tenant data. |
| `MfaRecoveryCode` | Same; bcrypt hashes only. |
| `UsageCounter` | Keyed to a user; consulted while establishing entitlements, before context. |
| `IdempotencyKey` | Written by the billing webhook, authenticated by signature, with no user or workspace. |
| `RateLimitCounter` | Keys are keyed digests, values are integers. Nothing to isolate, and the limiter runs before authentication on the paths that need it most. |
| `_prisma_migrations` | Schema bookkeeping. |

The exclusion list is **asserted by a test**. `tests/security/rls.test.ts` reads
`pg_class` for every table without `FORCE ROW LEVEL SECURITY` and compares it to
this list, so a new table added without a policy fails the build rather than
shipping unprotected.

That test has already earned its place once: the tables added in this pass —
`UserSession`, `MfaCredential`, `MfaRecoveryCode`, `RateLimitCounter`,
`SecurityAlert`, `JobRun` — were caught as uncovered, and the last two were given
policies as a result.

---

## Background jobs

Every handler runs inside `withTenantContext` for the job's own workspace
(`src/lib/jobs.ts`):

```ts
await withTenantContext(
  { workspaceIds: [job.workspaceId], userId: job.actorId },
  async () => handler({ ... }),
);
```

So a background job is subject to the same database-level isolation as a request,
**including when the handler forgets to filter**. This matters more for jobs than
for requests: a job has no user watching it, and a handler written a year from now
will not have `access.ts` in mind.

An adversarial test forges a job carrying workspace A and an entity id from
workspace B, and asserts the handler cannot reach the record.

---

## Privileged maintenance

Three ways, in order of preference:

1. **Set the context explicitly.** A maintenance script that knows which
   workspace it is fixing uses `withTenantContext` like everything else. This is
   the right answer for almost all of it.

2. **Connect as the owner.** The owner is bound by `FORCE`, so it sees nothing
   without context either — but it can `ALTER POLICY`, which is what makes it the
   migration role and not the request role.

3. **A role with `BYPASSRLS`.** For a genuine cross-tenant operation: a data
   migration, a support investigation, a compliance export. Create it
   deliberately, use it from a session a human is watching, and expect its use to
   appear in the database's own logs. The application never connects with one.

Migrations run as the owner. `prisma migrate deploy` creates and alters tables,
which requires ownership, and DDL is unaffected by RLS.

---

## Failure behaviour

| Situation | What happens |
|---|---|
| Context not set | Every policy evaluates `NULL`. Zero rows. Reads return empty, writes are refused. |
| Context set to another workspace | Zero rows for that tenant's data. An `INSERT` or a workspace-changing `UPDATE` raises `new row violates row-level security policy`. |
| Context cleared mid-transaction | Immediately closes; it never widens. Tested. |
| A malformed id in the context | `withTenantContext` throws before touching the database. |
| Connected as a superuser | **RLS does not apply.** Reported at error level on every boot. |
| Policies never applied | `rlsStatus()` reports `protectedTables: 0` and the same error. |
| The application role lacks a grant | `permission denied`. This is how `AuditLog` is append-only: `UPDATE` and `DELETE` are revoked, so tampering fails with a privilege error before a policy is consulted. |

A read that finds nothing and a read that is refused are deliberately
indistinguishable to a caller, matching the application layer's choice to return
"not found" rather than "forbidden".

---

## Cost

RLS adds a predicate to every query on a protected table. For the directly scoped
tables that is an equality against a small array — negligible, and it sits
alongside the `workspaceId` filter the application already adds. For the
indirectly scoped tables it is an `EXISTS` subquery on an indexed foreign key.

The measured effect: the whole suite and both load-test tiers run against
PostgreSQL with these policies applied, and at 100,000 contacts / 500,000
activities every screen query stays under 83 ms — faster than SQLite without RLS
at the same scale.

---

## Applying it

```bash
npx prisma migrate deploy
psql "$DATABASE_URL" -f prisma/postgres/001_search_indexes.sql
psql "$DATABASE_URL" -f prisma/postgres/002_row_level_security.sql
psql "$DATABASE_URL" -f prisma/postgres/003_deferrable_constraints.sql

# The migration creates tinycrm_app with NOLOGIN and no password on purpose:
# a credential in a migration file is a credential in version control.
psql "$DATABASE_URL" -c "ALTER ROLE tinycrm_app WITH LOGIN PASSWORD '<from your secret manager>';"
psql "$DATABASE_URL" -c "GRANT CONNECT ON DATABASE <db> TO tinycrm_app;"
```

Then point `DATABASE_URL` at `tinycrm_app` and confirm the startup log says
`row-level security active`.

Verify locally with `npm run test:pg`, which does all of the above against an
embedded PostgreSQL 17 and runs the 40 bypass attempts.

---

## What this does not do

- **It does not replace application-level isolation.** RLS cannot express "a
  viewer may not export", "the last owner may not be demoted", or "this foreign
  key must belong to the same workspace". Those are the first layer's job and it
  still does it.
- **It does not protect against a compromised application role.** Anyone who can
  set `app.workspace_ids` can set it to any workspace. The control is that the
  value comes from verified memberships, never from a request.
- **It does not apply on SQLite**, which has no equivalent. Development therefore
  has one layer, not two — worth remembering when reasoning about a bug found
  locally.
- **It does not encrypt anything.** A database copy is still readable; RLS is an
  access control inside a running server.
