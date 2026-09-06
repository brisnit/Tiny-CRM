# Deploying Tiny CRM to Vercel

Everything needed to take this repository to a hosted environment, and an honest
account of what Vercel changes about the architecture.

**Read this first:** the first deployment is **staging / owner testing**, not
general customer availability. `docs/PRODUCTION-READINESS.md` explains what is
still open. Nothing here changes that judgement.

---

## What Vercel changes

Tiny CRM was hardened on the assumption of a long-lived server process. Vercel
is not that. Four consequences, all of which are handled below rather than
hoped away.

| Assumption that no longer holds | Consequence | Handled by |
|---|---|---|
| A process that stays alive | `npm run worker` cannot run. Nothing drains the outbox. | `/api/cron/jobs` + `vercel.json` crons |
| A writable filesystem | Only `/tmp` is writable, per invocation. | The mail sink already refuses production and catches write failures |
| One instance | In-process rate-limit counters become per-lambda and reset constantly. | `RATE_LIMIT_BACKEND=postgres` + a truthful `APP_INSTANCES` |
| Few, long-lived DB connections | Every concurrent invocation can open its own pool. | A pooled `DATABASE_URL`, small `DATABASE_POOL_MAX` |

---

## 1. The database

**PostgreSQL is required. SQLite will not work on Vercel** — the filesystem is
ephemeral and per-invocation, so a `file:` database would be empty, unshared,
and discarded. The production configuration gate refuses it outright
(`src/lib/env.ts`: *"DATABASE_URL points at a local SQLite file"*).

Any managed PostgreSQL 17 works: Neon, Supabase, Vercel Postgres, RDS. Nothing
in the schema requires a specific host — the only extension used is `pg_trgm`,
created by `prisma/postgres/001_search_indexes.sql`.

### Two roles, and why it matters

**The application must not connect as the database owner, `postgres`, a
superuser, or the migration administrator.** This is not a stylistic preference:

- Row-level security is enforced with `FORCE ROW LEVEL SECURITY`, which binds
  the table owner — but **does not bind a superuser**. A superuser connection
  silently has no second isolation layer at all. This was verified, not assumed;
  see F-5 in `docs/POSTGRES-VERIFICATION.md`.
- `AuditLog` is append-only because `UPDATE` and `DELETE` are revoked from
  `tinycrm_app`. An owner connection can rewrite the audit trail.

| Role | Used by | Privileges |
|---|---|---|
| **owner / migration role** | `prisma migrate deploy`, the three SQL files, maintenance | Owns the tables. DDL. Never in `DATABASE_URL`. |
| **`tinycrm_app`** | The running application, every request | `SELECT/INSERT/UPDATE/DELETE` only. `NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE`. No `UPDATE`/`DELETE` on `AuditLog`. |

`tinycrm_app` is created by `002_row_level_security.sql` as `NOLOGIN` with no
password, deliberately — *a credential in a migration file is a credential in
version control*. Give it a login out of band, once:

```sql
ALTER ROLE tinycrm_app WITH LOGIN PASSWORD '<generated>';
GRANT CONNECT ON DATABASE <database> TO tinycrm_app;
```

The application boots with `rlsStatus()` (`src/lib/tenant-db.ts`), which asks
the database which role it is actually connected as and **logs at error level on
every boot** if that role is a superuser or the policies are missing. If you see
that line in Vercel's logs, RLS is not protecting you — fix it before onboarding
anyone.

### Why `vercel.json` has no comments

`vercel.json` is validated against a strict schema that rejects unknown
properties — including the `"//"` keys commonly used as JSON comments. Adding
them fails the build outright with *"should NOT have additional property `//`"*,
before any code runs. Keep that file minimal; the reasoning lives here.

**The build command deliberately does not run `prisma migrate deploy`.** A build
runs on every push, including every preview, and a preview inherits whatever
`DATABASE_URL` its environment supplies. Migrating from the build step would let
an in-flight branch alter the schema production is serving. Migrations are a
deliberate, separately-credentialed step (above). The runtime role has no DDL
grant so it would fail anyway; not relying on that is the point.

`prisma generate` *is* required: the client is generated into `src/generated`,
which is gitignored, so it does not exist in a fresh checkout.

### Applying the schema

Migrations are a **deliberate, separately-credentialed step**. They are not in
the build command, and must not be: a build runs on every push including every
preview, and a preview inherits whatever `DATABASE_URL` its environment holds.
Migrating from a build step means an in-flight branch can alter the schema
production is serving.

Run this yourself, from your machine, with the **owner** URL:

```bash
export DATABASE_URL='postgresql://<owner>:<pw>@<host>/<db>?sslmode=require'
npm run db:use-postgres          # switches provider + migration history
npx prisma migrate deploy
node scripts/apply-sql.mjs prisma/postgres/001_search_indexes.sql
node scripts/apply-sql.mjs prisma/postgres/002_row_level_security.sql
node scripts/apply-sql.mjs prisma/postgres/003_deferrable_constraints.sql
node scripts/apply-sql.mjs prisma/postgres/004_workspace_bootstrap.sql
node scripts/apply-sql.mjs prisma/postgres/005_identity_policies.sql
node scripts/apply-sql.mjs prisma/postgres/006_job_claim.sql
```

Then set the login password for `tinycrm_app` as above, and verify:

```bash
DATABASE_URL='postgresql://tinycrm_app:...' npx tsx -e \
  'import("./src/lib/tenant-db").then(m=>m.reportRlsStatus())'
```

`003_deferrable_constraints.sql` is not optional. `Company.primaryContactId` and
`Contact.companyId` form a foreign-key cycle, and without deferrable constraints
**a logical backup cannot be restored** — discovered by running the restore, not
by reading the schema.

---

## 2. Environment variables

Set these in **Vercel → Settings → Environment Variables**. `env.production.example`
is the annotated master copy.

Validate before deploying — this catches every problem at once rather than one
per boot:

```bash
NODE_ENV=production npm run check:config
```

### Required — the deployment will refuse to boot without these

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Vercel sets this. |
| `DATABASE_URL` | `postgresql://tinycrm_app:...@host/db?sslmode=require` | **Pooled** URL. Never the owner role. |
| `AUTH_SECRET` | `openssl rand -base64 32` | See below. |
| `APP_URL` | `https://your-domain` | Must be HTTPS, must not be localhost. |
| `APP_INSTANCES` | a number > 1 | See below. |
| `RATE_LIMIT_BACKEND` | `postgres` | Forced by `APP_INSTANCES > 1`. |

### Required for account security to actually function

| Variable | Notes |
|---|---|
| `MAIL_PROVIDER_URL`, `MAIL_PROVIDER_TOKEN`, `MAIL_FROM` | Without these, password reset and email verification **cannot deliver**. The app does not silently disable them: it logs a startup warning and the `LogAdapter` records the attempt without the link, so a token is never published to logs. A broken reset flow is better than one that leaks its own tokens — but it is still broken, so configure this. |
| `CRON_SECRET` | `openssl rand -base64 32`. Without it `/api/cron/jobs` returns 503 and **no background job ever runs**. |

### Optional

| Variable | Effect if unset |
|---|---|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | AI prose is unavailable. **Deterministic scoring, momentum, stall detection, health and the daily brief keep working** — they never needed a model. |
| `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `LOG_DRAIN_URL` | No external error reporting; structured logs still go to Vercel's log stream. |
| `ALERT_WEBHOOK_URL` | Security alerts are recorded in the database but not delivered anywhere. |
| `BILLING_WEBHOOK_SECRET` | Plan changes cannot be applied by a provider. |
| `DATABASE_POOL_MAX` | Defaults to 10. See §4. |

### Never set in production

`ALLOW_DEMO_AUTH`, `SEED_ALLOW_PRODUCTION`, `TINYCRM_TEST_IDENTITY`. The
configuration gate treats each as a fatal error, and `tests/security/config.test.ts`
asserts it.

### `AUTH_SECRET`

```bash
openssl rand -base64 32
```

Never commit it. It belongs only in Vercel's encrypted environment variables.
Compromise is total — any session for any user can be minted, and TOTP secrets
are encrypted with a key derived from it. The gate rejects the development
secret and anything under 32 characters.

Rotating it invalidates every session and **makes every enrolled TOTP secret
undecryptable**, so users must re-enrol MFA. Treat rotation as an incident
response step, not routine maintenance.

### `APP_INSTANCES` — do not leave this at 1 on Vercel

The default of `1` is a claim that there is exactly one process. On Vercel that
is false: concurrent invocations are separate lambdas with separate memory. If
you leave it at 1, the configuration gate is satisfied, in-process rate limiting
is accepted, and **every rate limit is silently multiplied by the number of warm
lambdas** — sign-in throttling, reset throttling and export limits included.

Set it to a realistic upper bound (e.g. `10`). The gate then *requires* a shared
counter store, which is the correct outcome.

### Rate limiting: Postgres, not Redis

`RATE_LIMIT_BACKEND=postgres` shares counters through the database you already
have, using the `RateLimitCounter` table. There is no reason to add Redis to
this deployment — it would be a second stateful dependency, a second failure
mode and a second bill for a workload of a few hundred counter updates per
minute. `RATE_LIMIT_REDIS_URL` remains supported if you later have independent
reasons to run Redis.

Counter keys are **keyed SHA-256 digests**, not raw emails or IPs, so the table
never becomes a second record of who uses the product and from where.

---

## 3. Domain, preview vs production

`APP_URL` must be the **production** domain, set only on the Production
environment. Do not set the production domain on Preview: a preview would then
mint cookies and email links claiming to be production.

For Preview, either leave `APP_URL` unset for a branch that need not send mail,
or set it to the Vercel-generated preview URL.

**A preview deployment must never point at the production database.** Vercel
environment variables are per-environment; set `DATABASE_URL` separately for
Preview, pointing at a branch/staging database. Neon and Supabase both offer
per-branch databases for exactly this. If you cannot provide a separate
database, do not enable preview deployments — a preview runs the same server
actions with the same privileges, and a destructive action on a preview is a
destructive action on real data.

Preview deployments should also **not** have `CRON_SECRET` set, so a preview
never processes the production queue.

---

## 4. Serverless database connections

Every concurrent lambda can open its own pool. The failure is not subtle: the
database refuses new connections and every request 500s.

- **Use a pooled connection string.** Neon: the `-pooler` host. Supabase: port
  `6543` (transaction mode). Vercel Postgres: the `POSTGRES_PRISMA_URL` form.
- **Keep `DATABASE_POOL_MAX` small** — `1`–`5`. With many lambdas, a per-lambda
  pool of 10 exhausts the server quickly. The adapter is already configured for
  this shape (`idleTimeoutMillis: 30_000`).

**Transaction-mode pooling is safe here.** The RLS tenant context uses
`set_config(..., true)` — that is `SET LOCAL`, scoped to the transaction, so it
travels correctly through PgBouncer in transaction mode. This was checked
specifically; see `docs/POSTGRES-VERIFICATION.md`. Session-level advisory locks
would *not* be safe, and the code does not use them.

If you use a pooled URL, migrations still need a **direct** (unpooled) URL —
DDL and advisory locks do not work through transaction pooling. That is a
separate credential used from your machine, not stored in Vercel.

---

## 5. The worker

**This is the most significant thing Vercel changes.**

`scripts/worker.ts` is a `while` loop. It cannot run on Vercel. Without a
replacement the `DomainEvent` outbox fills and never drains, which means:
automations never fire, scheduled workspace deletions never complete, overdue
task notifications never arrive, and retention sweeps never run — while the UI
continues to present all of those as working features.

`/api/cron/jobs` is the replacement. It does exactly what `npm run worker -- --once`
does: drain until empty, then stop. All claim, backoff, dead-letter and
idempotency logic still lives in `src/lib/jobs.ts` — this is plumbing, not a
second implementation.

- Scheduled by `vercel.json`: every 5 minutes, plus a daily sweep.
- Authenticated by `CRON_SECRET` via `Authorization: Bearer`, compared in
  constant time. Returns 401 without it, **503 if the secret is unset** — it
  fails visibly rather than running unauthenticated.
- Bounded by a 45-second budget inside a 60-second `maxDuration`, so it returns
  a truthful summary rather than being killed mid-batch.

**Vercel plan limits matter here.** Hobby allows only daily cron and 2 jobs;
5-minute scheduling requires Pro. On Hobby, background work is delayed by up to
24 hours — which for scheduled workspace deletion and overdue notifications is
a real behavioural difference. Either use Pro, or drive the endpoint from an
external scheduler (GitHub Actions, cron-job.org, QStash) with the same bearer
token.

**Dead-lettered jobs are not retried automatically, by design** — a poisoned job
must not block the queue. The endpoint logs a warning when any exist. Nothing
currently pages you about it; check `listDeadJobs()` or the queue depth in the
response.

---

## 6. Observability and alerting

Error reporting is built from an **explicit allowlist** — type, message, stack,
request id, route, and user/workspace **ids** — not from an SDK's automatic
instrumentation. Messages are scrubbed of quoted rows and email addresses;
stacks are stripped of filesystem paths (`src/lib/observability.ts`). CRM record
contents, AI prompts, passwords, tokens, email bodies and note text are never
sent. `redact()` in `src/lib/logger.ts` runs over log, audit and alert metadata.

Set `SENTRY_DSN` and/or `OTEL_EXPORTER_OTLP_ENDPOINT` to export. Without them,
structured logs still reach Vercel's log stream, which is retained for a limited
window depending on plan — configure `LOG_DRAIN_URL` if you need longer.

`ALERT_WEBHOOK_URL` delivers **security alerts**, which are deliberately a
smaller set than audit events: sign-in brute force, mass export, RLS status
failure, and similar. Not every audit event is an alert. If the variable is
unset, alerts are still recorded in `SecurityAlert` and visible in the app, but
nobody is notified.

---

## 7. Backups

**Vercel does not back up your database.** Whatever managed PostgreSQL you chose
is where backups live, and enabling them is a step you must take there.

Before onboarding anyone whose data you cannot afford to lose:

1. Turn on automated backups / point-in-time recovery at the provider.
2. **Perform a real restore into a scratch database and verify it.**
   `npm run test:backup` proves the schema and data round-trip through a
   destroy/restore cycle locally, and it caught the deferrable-constraint defect
   that would have made a restore impossible. It does **not** prove your
   provider's `pg_dump`/PITR path — only the provider can, and only by you
   actually doing it.
3. Write down the RPO and RTO you are actually getting, and check they match
   what `docs/INCIDENT-RESPONSE.md` assumes.

A backup that has never been restored is a hypothesis, not a backup.

---

## 8. Deployment steps

```
1.  Provision managed PostgreSQL 17.
2.  From your machine, with the OWNER url:
      npm run db:use-postgres
      npx prisma migrate deploy
      node scripts/apply-sql.mjs prisma/postgres/001_search_indexes.sql
      node scripts/apply-sql.mjs prisma/postgres/002_row_level_security.sql
      node scripts/apply-sql.mjs prisma/postgres/003_deferrable_constraints.sql
node scripts/apply-sql.mjs prisma/postgres/004_workspace_bootstrap.sql
node scripts/apply-sql.mjs prisma/postgres/005_identity_policies.sql
node scripts/apply-sql.mjs prisma/postgres/006_job_claim.sql
3.  ALTER ROLE tinycrm_app WITH LOGIN PASSWORD '<generated>';
    GRANT CONNECT ON DATABASE <db> TO tinycrm_app;
4.  Verify RLS binds:  reportRlsStatus() as tinycrm_app.
5.  Import the repo in Vercel. Framework: Next.js (auto-detected).
    Build command comes from vercel.json — do not override it.
6.  Set Production environment variables (§2). Use the POOLED, tinycrm_app URL.
7.  NODE_ENV=production npm run check:config     # locally, same values
8.  Deploy.
9.  Watch the boot logs for the rlsStatus() error line. If present, stop.
10. Run the smoke tests below.
11. Enable provider backups and perform one real restore.
```

### Smoke tests, in order, on the deployed URL

Do these as the owner, on real infrastructure, before anyone else has an account.

| # | Check | Expected |
|---|---|---|
| 1 | `GET /api/health` | 200 |
| 2 | `GET /api/ready` | 200 — proves migrations ran |
| 3 | Sign up a new account | Succeeds; verification email arrives |
| 4 | Verify the email | State changes to verified |
| 5 | Sign out, sign in | Succeeds |
| 6 | Password reset end to end | Email arrives; token works once; **prior sessions revoked** |
| 7 | Create contact → company → deal → note | All persist across a reload |
| 8 | Move a deal between stages | Persists |
| 9 | Search for a term with `_` in it | Matches literally, not as a wildcard |
| 10 | Create a second workspace; confirm records do not cross | Isolation holds |
| 11 | Settings → Security → Active Sessions | Lists the session; revoking it signs that device out |
| 12 | Archive a record, then Settings → Trash | Recoverable |
| 13 | Export a CSV | Requires a verified email; audited |
| 14 | `curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/jobs` | 200 with a JSON summary |
| 15 | Same without the header | 401 |
| 16 | Browser console on any page | No CSP violation, no hydration error |
| 17 | Vercel boot logs | No `rlsStatus()` error line |

If 6, 14 or 17 fail, the deployment is not usable by anyone but you.

---

## 9. What this document does not claim

- That Tiny CRM is production ready. It is not; see `docs/PRODUCTION-READINESS.md`.
- That your provider's backups work. Only your own restore proves that.
- That MFA is complete. It is a foundation; `MFA_ENFORCED_AT_SIGN_IN` is false
  and the UI says so.
- Any compliance or legal position. No framework assessment has been performed.
