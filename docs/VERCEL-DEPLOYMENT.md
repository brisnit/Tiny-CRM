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
| **owner / migration role** | `prisma migrate deploy`, the six SQL files in `prisma/postgres`, maintenance | Owns the tables. DDL. Never in `DATABASE_URL`. |
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

**The build command's first step is the deployment gate** — see *The
deployment gate* below. It reads the database; it never migrates it.

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
node scripts/apply-sql.mjs prisma/postgres/007_account_scoped_ai_threads.sql
node scripts/apply-sql.mjs prisma/postgres/008_person_scoped_ai_output.sql
node scripts/apply-sql.mjs prisma/postgres/009_record_grants.sql
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

### The deployment gate

Every Vercel build runs `node scripts/deploy-gate.mjs` before anything else
(`buildCommand` in `vercel.json`). Where that build has a database — always, in
production — it does not proceed unless the database in its `DATABASE_URL`, in
production the restricted `tinycrm_app` role, satisfies all of these (the one
build that has no database of its own, a preview, is covered below):

1. **Every migration this commit ships is applied** (finished, not rolled back).
   A database *ahead* of the commit passes, as `/api/ready` does, so a rollback
   is never blocked.
2. **No foreign key is non-deferrable.** Otherwise a logical restore fails.
3. **No table has row-level security enabled without `FORCE`.**
4. **Every table with a `workspaceId` column has row-level security**, except the
   exceptions in `docs/RLS.md` (today, `IdempotencyKey`). A unit test fails if
   the gate's allowlist and that document ever disagree.

It exists because of two incidents that no check stopped. On 2026-09-11 a
migration-bearing commit reached production on push while its migration was
unapplied, for four days. On 2026-09-10 an applied migration was not followed by
`003`, leaving three foreign keys non-deferrable for five days while hosted
verification reported "108 deferrable foreign keys" as a pass. Both are now a
failed build instead of a silent incompatibility.

**Production fails closed, and there is no override.** In a production build —
and in every build that is not a preview — no PostgreSQL `DATABASE_URL`, an
unreachable database, an unreadable ledger or a query error all block. Its reads
run in a `READ ONLY` transaction. There is no environment variable, flag or
setting that skips it — a unit test pins the variables it may read. The only ways
past a block are to fix the database, or to change the gate in source control.

**A preview with no database of its own is skipped, not blocked.** There is no
Preview database yet, and a preview must never point at production's (section
3), so blocking only turned every branch red for a reason no branch could fix. A
build whose `VERCEL_ENV` is exactly `preview` **and** that has no `DATABASE_URL`
at all prints

```
DEPLOYMENT GATE: SKIPPED — preview build has no isolated Preview database
```

and continues. The skip never looks for a database anywhere else: it creates no
client, and does not read `DIRECT_URL`, the `POSTGRES_*` variables, the `PG*`
variables node-postgres would otherwise default to, or any `.env` file. The unit
suite plants production-shaped credentials in all of those, behind a listener
that counts connections, and requires zero; `deploy-gate-proof.mjs` does the same
with a real database's working credentials. A preview that *is* given a
PostgreSQL `DATABASE_URL` is checked like any other build — whether that is the
right rule for an isolated Preview database is a decision for when one exists.

This is not a way around the gate for production. The only way to reach the skip
on a production deployment is to remove production's `DATABASE_URL`, which stops
the application itself from running.

**What a skipped preview then builds.** The next step of the build command,
`use-provider.mjs auto`, has nothing to resolve a provider from, so it makes the
same narrow exception — preview, and no `DATABASE_URL` at all — and leaves the
committed provider untouched rather than failing. `prisma generate` and
`next build` need no database, so the build completes. Measured in a clean
checkout with no `.env`, running exactly the chain in `vercel.json`:

| `VERCEL_ENV` | build command | what it printed |
|---|---|---|
| `preview` | **exit 0** | gate `SKIPPED`, provider left as committed, client generated, compiled, pages emitted |
| `production` | **exit 1** | gate `BLOCKED` — the build stops there |

A preview built this way is **a build of the branch, not a working
environment**: it has no database, so any page that reads data fails at
runtime. It is enough to see that a branch compiles. Giving Preview its own
isolated database — a Neon branch, say — is what would make one usable, and at
that point the rule for whether Preview runs its own gate should be decided
deliberately.

**The order this enforces:**

1. Apply the migration and re-apply `001`–`006` from your machine, with the owner
   URL (*Applying the schema*, above).
2. Push to `main`.

If you push first, the build fails with the missing migration named, and
**production keeps serving the previous deployment** — a failed build never
replaces the live one. Apply the change, then redeploy the failed deployment from
the Vercel dashboard. This is a real blocked build, from the proof below
(Vercel deployment `dpl_2Xbi3GCAVbdNd72KVwC3o3ZvSTGZ`):

```
Running "node scripts/deploy-gate.mjs && node scripts/use-provider.mjs auto && prisma generate && next build"
Deployment gate — production build
  database fingerprint: 1391b7c11c1d  (a hash of host and database name)
  migrations:          3 shipped by this commit, 2 applied in the database
  foreign keys:        0 non-deferrable
  row-level security:  0 enabled without FORCE; 0 workspace tables unprotected (documented exceptions: IdempotencyKey)

DEPLOYMENT GATE: BLOCKED — this build will not proceed.

  ✕ 1 migration shipped by this commit is not applied to the database:
      20260911180102_workspace_invitations
Error: Command "node scripts/deploy-gate.mjs && …" exited with 1
```

The fingerprint identifies which database was checked without printing its host,
role or password.

**Where it is proven.** `tests/unit/deploy-gate.test.ts` pins the verdict and the
properties that keep it honest (no writes, no override, the allowlist matches
`docs/RLS.md`, `vercel.json` runs it first). `scripts/deploy-gate-proof.mjs` runs
in the PostgreSQL CI job on 17 and 18: it builds throwaway databases — one
current, one per failure — and runs the real gate against each as the
restricted role, including once as a role that can read nothing but the ledger,
to prove the `workspaceId` check cannot be hidden by missing privileges.

### Deployments that do not run Vercel's build

`vercel deploy --prebuilt` uploads an output built elsewhere, so no build runs on
Vercel. One control is proven in code; the rest is policy.

**A production output built for `--prebuilt` is gated too.** `vercel build`
runs the same `buildCommand`, gate first. Verified locally on 2026-09-15:
`vercel build --prod` pulled the production settings, ran the gate as a
*production build*, and blocked, because Vercel redacts the sensitive
`DATABASE_URL` when environment variables are pulled. An operator who has not
deliberately supplied a database cannot produce a passing production build.

**And the CLI refuses to deploy what a blocked build leaves behind.** A failed
`vercel build` still writes `.vercel/output`, but only as a record of the failure:
its `builds.json` carries the error. Verified on 2026-09-15 —
`vercel deploy --prebuilt --prod` exited 1 with *"Prebuilt deployment cannot be
created because `vercel build` failed with error"*, created no deployment, and
production did not change. So the accidental path is closed end to end: a gate
block produces no output that `--prebuilt` will deploy.

**Beyond that it is a policy, stated here because code cannot enforce it.** Any
control inside a build is skipped by a deployment that does not run that build,
and a prebuilt output is whatever its uploader built. So:

- **Production is deployed only by pushing to `main`**, through Vercel's GitHub
  integration, which always runs the gate.
- **Nobody runs `vercel deploy --prod` or `vercel deploy --prebuilt --prod`
  against this project.** In a genuine emergency, the fix is a reviewed commit
  pushed to `main` — a revert, or a change to the gate itself — which passes
  through the gate like any other. It is not a CLI deployment.
- **CI holds no Vercel token and never deploys.** Keep it that way; a token in CI
  is a production deployment path that skips review.
- Only people who need to create deployments hold Vercel access.

What remains is deliberate circumvention by someone with deployment access —
supplying a different database to `vercel build`, or hand-building an output.
That is an access-control question, not a gating one. It is also still visible:
`/api/ready` returns `503 schema_behind` for any deployment whose code is ahead of
its database, however it was deployed, and Vercel's deployment list records how
each deployment was created.

A platform-level control was considered and does not close this gap: Vercel
Deployment Checks (available on this team's Pro plan) hold a production
deployment until *GitHub* checks pass. A CLI deployment is recorded by Vercel as
`source: cli` and creates no GitHub deployment record — observed on the proof
deployments below — so GitHub-backed checks have nothing to attach to. Against a
deliberate CLI deployment, access control is the control.

### Proven on Vercel, 2026-09-15

Not a simulation: real Vercel builds, of the gate commit `1e356cc`, against a
real database in each state. The database for the failures was a Neon branch of
production as it stood at 20:02 UTC that day, before that day's migration was
applied; its ledger was read before use and held 2 of the 3 migrations, so it was
genuinely one migration behind. The build reached it through
`vercel deploy --build-env DATABASE_URL=…`, which overrides the project's own value
for one deployment only; production's settings were never changed. The role in
that URL was created by SQL on the branch alone, so it never existed in
production, and it was destroyed with the branch. Its credential does not appear
in any build log or in Vercel's API.

The fingerprint in each log shows which database was checked: `1391b7c11c1d` is
the branch, `18155d6dda02` is production.

| # | Deployment | Database the build checked | Gate | Outcome |
|---|---|---|---|---|
| 0 | *(local run)* | the untouched branch — production as it stood before the 2026-09-15 fix | **BLOCKED**: the missing migration **and** the three non-deferrable import-table keys | Both real incidents would have been stopped |
| 1 | `dpl_2Xbi3GCAVbdNd72KVwC3o3ZvSTGZ` — production, `--skip-domain` | branch, one migration behind (`1391b7c11c1d`) | **BLOCKED**, named `20260911180102_workspace_invitations`, exit 1 | **Error**. Proves `--build-env` reaches the build rather than production |
| 2 | `dpl_HFJyLtH1GSLA8pkWDRUq4G9kkCEH` — production, auto-assign **on** | the same branch | **BLOCKED**, exit 1 | **Error**. `tinycrm.biz` stayed on `dpl_3R1Y5YSLfkrhicaAYeBcoPfLV8iW` (release `8efb0a3`) before and after: a blocked build does not replace production |
| 3 | `vercel build --prod`, then `vercel deploy --prebuilt --prod --skip-domain` | none — pulled production settings redact `DATABASE_URL` | **BLOCKED** | The CLI refused the leftover output; **no deployment created** |
| 4 | `dpl_J2j1S5eUCMNMf31D1teKSB9PypLY` — production, `--skip-domain` | the same branch, after `migrate deploy` and `001`–`006` | **PASSED**, 3 of 3 | Build completed, **Ready**, not assigned; removed afterwards |
| 5 | `dpl_5iyubHXcneikZFCr2DPWVxM1LRtG` — the normal push of `1e356cc` | **production** (`18155d6dda02`) | **PASSED**, 3 of 3, 0 non-deferrable, 0 RLS gaps | Became production; `/api/ready` 200 |

Before the branch was used for (1) and (2), `003` was run on it so the missing
migration was the only defect; the unmodified state in (0) shows both. The branch
and every credential it carried were deleted at the end.

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
      node scripts/apply-sql.mjs prisma/postgres/007_account_scoped_ai_threads.sql
      node scripts/apply-sql.mjs prisma/postgres/008_person_scoped_ai_output.sql
      node scripts/apply-sql.mjs prisma/postgres/009_record_grants.sql
3.  ALTER ROLE tinycrm_app WITH LOGIN PASSWORD '<generated>';
    GRANT CONNECT ON DATABASE <db> TO tinycrm_app;
4.  Verify RLS binds:  reportRlsStatus() as tinycrm_app.
5.  Import the repo in Vercel. Framework: Next.js (auto-detected).
    Build command comes from vercel.json — do not override it.
6.  Set Production environment variables (§2). Use the POOLED, tinycrm_app URL.
7.  NODE_ENV=production npm run check:config     # locally, same values
8.  Deploy by pushing to main. The build runs the deployment gate first; if it
    blocks, apply what it names and redeploy — production is not replaced.
9.  Watch the boot logs for the rlsStatus() error line. If present, stop.
10. Run the smoke tests below.
11. Enable provider backups and perform one real restore.
```

### Smoke tests, in order, on the deployed URL

Do these as the owner, on real infrastructure, before anyone else has an account.

| # | Check | Expected |
|---|---|---|
| 1 | `GET /api/health` | 200 |
| 2 | `GET /api/ready` | 200 — proves the deployed code and its database agree |
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
