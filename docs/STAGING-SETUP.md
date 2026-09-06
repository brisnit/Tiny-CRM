# Staging setup — the exact steps

Everything you need to do by hand to get Tiny CRM running as a
**staging / owner-testing** environment. Written to be followed top to bottom.

Nothing here has been executed. Every command below was validated against a real
PostgreSQL 17 locally, but the hosted environment does not exist yet, so no
result in this file is a verified claim about your deployment. `npm run
verify:hosted` is how you turn each one into evidence.

---

## Recommendations, and why

| Need | Recommendation | Why this one |
|---|---|---|
| Database | **Neon** | Serverless Postgres 17, a real pooled endpoint *and* a direct endpoint (which is exactly the split this app needs), database branching for preview isolation, and a free tier that covers owner testing. Supabase is a fine alternative; it bundles auth and storage you will not use. |
| Scheduler | **Vercel Cron** (`vercel.json`, every 5 minutes) | The team hosting this project is on the **Pro** plan, whose cron supports minute-level schedules. The GitHub Actions workflow remains as a manual fallback. |
| Email | **Resend** | Simplest API of the transactional providers, generous free tier, and it works with the existing `HttpAdapter` with no code change. |
| Alerts | **Slack or Discord incoming webhook** | A URL, no account provisioning, no per-seat cost. |
| Errors | **Sentry** free tier | The observability adapter already targets it. |
| Rate limiting | **Postgres** (`RATE_LIMIT_BACKEND=postgres`) | Reuses the database you already have. Do not add Redis at this stage. |

---

## Step 1 — Create the database (Neon)

1. Sign up at neon.tech, create a project, **Postgres 17**, region nearest you.
2. Name the database `tinycrm`.
3. From the dashboard, copy **two** connection strings — Neon shows both:
   - **Pooled** — host contains `-pooler`. This is `DATABASE_URL`.
   - **Direct** — no `-pooler`. This is `DIRECT_URL`, migrations only.
4. Both must end with `?sslmode=require`.

The role Neon gives you (usually `neondb_owner`) is the **owner/admin** role. It
is used for migrations and never by the application.

---

## Step 2 — Generate secrets

Run locally. **Do not commit these, do not paste them into any file in the
repo, and do not put them in a chat message.**

```bash
openssl rand -base64 32     # AUTH_SECRET
openssl rand -base64 32     # CRON_SECRET
openssl rand -base64 24     # password for the tinycrm_app role
```

Three separate values. Reusing one across roles removes the point of separating
them.

---

## Step 3 — Apply the schema, as the ADMIN role

From your machine, not from Vercel.

```bash
export DIRECT_URL='postgresql://<owner>:<pw>@<direct-host>/tinycrm?sslmode=require'
export DATABASE_URL="$DIRECT_URL"     # only for this step

npm run db:use-postgres
npx prisma generate
npx prisma migrate deploy

node scripts/apply-sql.mjs prisma/postgres/001_search_indexes.sql
node scripts/apply-sql.mjs prisma/postgres/002_row_level_security.sql
node scripts/apply-sql.mjs prisma/postgres/003_deferrable_constraints.sql
node scripts/apply-sql.mjs prisma/postgres/004_workspace_bootstrap.sql
node scripts/apply-sql.mjs prisma/postgres/005_identity_policies.sql
node scripts/apply-sql.mjs prisma/postgres/006_job_claim.sql
```

`003` is not optional. `Company.primaryContactId` and `Contact.companyId` form a
foreign-key cycle; without deferrable constraints a logical restore is
impossible. That was found by running a restore, not by reading the schema.

---

## Step 4 — Give the runtime role a login

`002_row_level_security.sql` creates `tinycrm_app` as `NOLOGIN` with no password
on purpose — *a credential in a migration file is a credential in version
control*. Set one now, connected as the **owner**, using the password from
Step 2:

```sql
ALTER ROLE tinycrm_app WITH LOGIN PASSWORD '<generated-password>';
GRANT CONNECT ON DATABASE tinycrm TO tinycrm_app;
```

The role's privileges were already set by the migration, but verify rather than
assume — this is the control the whole tenancy model rests on:

```sql
-- Expect: rolsuper=f, rolbypassrls=f, rolcreatedb=f, rolcreaterole=f
SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
FROM pg_roles WHERE rolname = 'tinycrm_app';

-- Expect: 0. The runtime role must not own any table — FORCE RLS binds the
-- owner, but ownership also carries DDL.
SELECT count(*) FROM pg_tables
WHERE schemaname = 'public' AND tableowner = 'tinycrm_app';

-- Expect: no UPDATE or DELETE rows. The audit log is append-only.
SELECT privilege_type FROM information_schema.role_table_grants
WHERE grantee = 'tinycrm_app' AND table_name = 'AuditLog';
```

If `tinycrm_app` ends up owning tables (some providers assign ownership on
creation), fix it:

```sql
REASSIGN OWNED BY tinycrm_app TO <owner-role>;
```

### Neon-specific note

Neon's console creates roles with its own defaults. Create `tinycrm_app` through
**SQL** as above, not through the console's "Roles" UI, so it does not inherit
elevated defaults. Verify with the queries above regardless.

---

## Step 5 — Prove it, before deploying anything

```bash
ADMIN_URL='postgresql://<owner>:<pw>@<direct-host>/tinycrm?sslmode=require' \
APP_URL_DB='postgresql://tinycrm_app:<pw>@<pooled-host>/tinycrm?sslmode=require' \
npm run verify:hosted
```

20 checks: server version, TLS, that the runtime role is not a superuser and
does not bypass RLS and owns nothing, that RLS is enabled *and forced* with
policies on every table, that a bare `SELECT *` with no tenant context returns
zero rows, that `UPDATE`/`DELETE` on `AuditLog` are refused, that a scoped
connection cannot see another workspace, and that every SQL file landed.

It prints **HOSTED RLS VERIFIED: YES / PARTIAL / NO**. Anything but `YES` means
stop and fix, not proceed and note.

The cross-tenant checks need two workspaces to exist; they report as *skipped*,
not passed, if there are fewer. Create a second workspace in the app first, then
re-run.

---

## Step 6 — Import into Vercel

1. vercel.com → **Add New… → Project**.
2. **Import Git Repository** → authorise GitHub → choose **`brisnit/Tiny-CRM`**.
3. Framework Preset: **Next.js** (auto-detected — leave it).
4. **Do not override the Build Command.** It comes from `vercel.json`
   (`prisma generate && next build`) and deliberately does not run migrations.
5. Expand **Environment Variables** and enter the table below for **Production**.
6. **Deploy.**

Then set the production branch: **Settings → Git → Production Branch = `main`**.

### Turn off preview deployments for now

**Settings → Git → Ignored Build Step**, or simply do not push branches. A
preview runs the same server actions with the same privileges; until it has its
own database (Neon branch), a preview pointed at staging data can mutate it.

---

## Step 7 — Environment variables

Enter under **Settings → Environment Variables**. The "Where" column is which
Vercel environment to tick.

### Required for the first staging deploy

| Variable | Controls | Where to get it | Where |
|---|---|---|---|
| `DATABASE_URL` | The app's database connection | Neon **pooled** URL, `tinycrm_app` role, `?sslmode=require` | Production |
| `AUTH_SECRET` | Session signing; TOTP encryption key | `openssl rand -base64 32` (Step 2) | Production |
| `APP_URL` | Canonical URL for links, cookies, email | The `https://` Vercel domain, **after** the first deploy (Step 8) | Production |
| `APP_INSTANCES` | Declares multi-instance so rate limits are shared | Enter `10` | Production |
| `RATE_LIMIT_BACKEND` | Where rate-limit counters live | Enter `postgres` | Production |
| `CRON_SECRET` | Authenticates `/api/cron/jobs` | `openssl rand -base64 32` (Step 2) | Production only — **never Preview** |
| `NODE_ENV` | Enables the production config gate | Vercel sets this automatically | — |

`DIRECT_URL` is **deliberately absent**. It is the admin credential; the config
gate now treats its presence in the app environment as a fatal error.

### Required before any external customer uses this

| Variable | Controls | Where to get it | Where |
|---|---|---|---|
| `MAIL_PROVIDER_URL` | Transactional email endpoint | `https://api.resend.com/emails` | Production |
| `MAIL_PROVIDER_TOKEN` | Email API key | Resend dashboard → API Keys | Production |
| `MAIL_FROM` | Sender identity | `Tiny CRM <noreply@your-domain>` — needs a verified domain in Resend | Production |
| `ALERT_WEBHOOK_URL` | Where security alerts are delivered | Slack/Discord incoming webhook URL | Production |
| `SENTRY_DSN` | Error reporting | Sentry → Project Settings → Client Keys (DSN) | Production |

Without the mail variables, password reset and email verification **cannot
deliver**. The app does not silently disable them: it warns at startup and
records the attempt without the link, so a token is never written to logs. That
is a broken flow, not a safe one — configure it before anyone else has an account.

### Optional

| Variable | Effect if unset | Where |
|---|---|---|
| `ANTHROPIC_API_KEY` | No AI prose. **All deterministic scoring, momentum, stall detection, health and the daily brief keep working.** | Production |
| `AI_PROVIDER` | Defaults to `auto`. Set `offline` to guarantee nothing leaves. | Production |
| `DATABASE_POOL_MAX` | Defaults to 10. **Set `3`** for serverless. | Production |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `LOG_DRAIN_URL` | Logs stay in Vercel's stream only | Production |
| `BILLING_WEBHOOK_SECRET` | Plan changes cannot be applied | Production |
| `APP_RELEASE` | Release tag on error reports | Production |

### Never set

`ALLOW_DEMO_AUTH`, `SEED_ALLOW_PRODUCTION`, `TINYCRM_TEST_IDENTITY`, `DIRECT_URL`.
Each is a fatal configuration error, asserted by `tests/security/config.test.ts`.

Validate the whole set locally before deploying — it reports every problem at
once rather than one per boot:

```bash
NODE_ENV=production npm run check:config
```

---

## Step 8 — `APP_URL`, the chicken-and-egg

You cannot know the domain before the first deploy. So:

1. Deploy once with `APP_URL` set to anything HTTPS (the gate only requires
   HTTPS and not-localhost).
2. Copy the real domain Vercel assigns, e.g. `tiny-crm-xxxx.vercel.app`.
3. Update `APP_URL` to exactly that, **Production only**.
4. Redeploy.

Do **not** set `APP_URL` on Preview. A preview would then mint cookies and email
links claiming to be the canonical application.

---

## Step 9 — Scheduler

Vercel Hobby cron is **daily only**, which cannot exercise worker behaviour. Use
GitHub Actions instead. Add `CRON_SECRET` and `STAGING_URL` under
**GitHub → Settings → Secrets and variables → Actions**, then commit
`.github/workflows/cron.yml` (provided in this repo).

`vercel.json` still declares Vercel crons, so they work if you later move to Pro.
Both firing is harmless — the endpoint drains until empty and is idempotent.

### Verify the worker by hand

```bash
# Expect 200 and a JSON summary
curl -s -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/jobs

# Expect 401
curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/api/cron/jobs

# Expect 401
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer wrong" \
  https://<domain>/api/cron/jobs
```

---

## Step 10 — Email (Resend)

1. resend.com → sign up → **API Keys** → create one with **Sending access**.
2. **Domains** → add your domain → add the DNS records it shows → wait for
   verification. Until then you can only send to your own address.
3. Set `MAIL_PROVIDER_URL`, `MAIL_PROVIDER_TOKEN`, `MAIL_FROM`.
4. Verify by requesting a password reset for your own account and confirming the
   email arrives and the link works exactly once.

---

## Step 11 — Alerts

1. Slack: **Apps → Incoming Webhooks → Add to Slack**, pick a channel, copy the
   URL. Discord: **Channel → Edit → Integrations → New Webhook**.
2. Set `ALERT_WEBHOOK_URL`.
3. Trigger a harmless real alert: sign in with a wrong password ~6 times to fire
   the repeated-authentication-failure alert. Confirm the message arrives.

Security alerts are deliberately a smaller set than audit events — mass export,
role escalation, workspace deletion, repeated auth failures, configuration
failures. Not every audit event is an alert.

---

## Step 12 — Sentry

1. sentry.io → new project → **Next.js** → copy the DSN.
2. Set `SENTRY_DSN`, redeploy.
3. Trigger a handled error and confirm the event arrives with a request id, and
   that no CRM content, note text, prompt or token appears in it.

The adapter sends an explicit allowlist — type, message, stack, request id,
route, user/workspace ids — not an SDK's automatic instrumentation. Messages are
scrubbed of quoted values and email addresses; stacks are stripped of paths.

---

## Step 13 — Backups

1. Neon: point-in-time recovery is on by default; confirm the retention window
   on your plan (free tier is short — check it).
2. Create representative data in staging.
3. **Restore to a new branch/database** — never over the live one.
4. Point `verify:hosted` at the restored database and confirm RLS, isolation and
   relationships survived.

A backup that has never been restored is a hypothesis.

---

## Step 14 — Custom domain (later, no code change needed)

Nothing in the app hardcodes a domain; `APP_URL` is the only thing that must
change.

1. Vercel → **Settings → Domains → Add** → `app.example.com`.
2. At your DNS provider, add the record Vercel shows — usually
   `CNAME app → cname.vercel-dns.com`. For an apex domain use Vercel's A record.
3. Wait for the certificate to be issued.
4. Update `APP_URL` to `https://app.example.com`, Production only. **Redeploy.**
5. Re-run the smoke tests — cookie domain and email links both derive from
   `APP_URL`.

Existing sessions survive a domain change only if the cookie domain still
matches; expect to sign in again.
