# Deployment checklist

Everything that has to be true before Tiny CRM holds real client data, in the
order you should do it. Items marked **BLOCKER** must be done; the rest are
graded in `docs/PRODUCTION-READINESS.md`.

---

## 0. Before you start

Read `docs/PRODUCTION-READINESS.md` first. It says plainly which parts of this
system are production-ready and which are not, and there are things on that
list — Redis-backed rate limiting, a verified backup restore, password reset —
that no amount of correct deployment will substitute for.

---

## 1. Database

- [ ] **BLOCKER** Provision PostgreSQL 15 or newer. Managed, with automated
      backups and point-in-time recovery. Neon, Supabase, RDS and Cloud SQL all
      qualify; a container on the app host does not.
- [ ] **BLOCKER** Switch the datasource and regenerate:
      ```bash
      npm run db:use-postgres
      npx prisma generate
      ```
      This changes one word in `prisma/schema.prisma`. The schema is written to
      be provider-agnostic — no native enums, no scalar lists, no `Json` columns,
      money as integer cents — so nothing else changes.
- [ ] **BLOCKER** Apply migrations: `npx prisma migrate deploy`.
      Never `migrate dev` against production; it can drop data.
- [ ] **BLOCKER** Apply all three PostgreSQL-only SQL files, in order:
      ```bash
      psql "$DATABASE_URL" -f prisma/postgres/001_search_indexes.sql
      psql "$DATABASE_URL" -f prisma/postgres/002_row_level_security.sql
      psql "$DATABASE_URL" -f prisma/postgres/003_deferrable_constraints.sql
      psql "$DATABASE_URL" -f prisma/postgres/004_workspace_bootstrap.sql
      psql "$DATABASE_URL" -f prisma/postgres/005_identity_policies.sql
      psql "$DATABASE_URL" -f prisma/postgres/006_job_claim.sql
      ```
      None is optional:

      **001** — substring search compiles to `ILIKE '%term%'`, which a btree index
      cannot serve. Without the `pg_trgm` GIN indexes it degrades to a sequential
      scan past a few thousand rows. `CREATE INDEX CONCURRENTLY` cannot run
      inside a transaction, so use `psql -f`, not a migration runner.

      **002** — row-level security, the second tenant-isolation layer. Without it
      a query that forgets its workspace filter returns every tenant's rows.

      **003** — deferrable foreign keys. `Company` and `Contact` reference each
      other, so **without this a logical restore is impossible** — no table
      ordering satisfies a cycle. This was found by running the restore drill,
      not by reading the schema.

- [ ] **BLOCKER** Connect the application as the RLS-restricted role, not the
      owner:
      ```bash
      psql "$DATABASE_URL" -c "ALTER ROLE tinycrm_app WITH LOGIN PASSWORD '<from your secret manager>';"
      psql "$DATABASE_URL" -c "GRANT CONNECT ON DATABASE <db> TO tinycrm_app;"
      ```
      Then point `DATABASE_URL` at `tinycrm_app`. **A superuser bypasses
      row-level security even on a table marked FORCE** — a deployment connected
      as one has the policies fully installed and no second layer at all. The
      startup log says `row-level security active` when it is working, and logs
      at error level when it is not. See `docs/RLS.md`.
- [ ] **BLOCKER** Do **not** run `npm run db:seed`. It creates demo workspaces,
      demo companies and a known account. It refuses to run in production
      without `SEED_ALLOW_PRODUCTION`, and the startup gate refuses to boot if
      that variable is set — both guards should stay untouched.
- [ ] The audit log is already append-only for the application role —
      `002_row_level_security.sql` revokes `UPDATE` and `DELETE` on `AuditLog`.
      Confirm it survived:
      ```sql
      SELECT has_table_privilege('tinycrm_app', '"AuditLog"', 'UPDATE');  -- false
      ```
- [ ] Set `DATABASE_POOL_MAX` to match your host's connection limit divided by
      the number of instances. The default is 10 per instance.
- [ ] Confirm the database is not reachable from the public internet.

## 2. Secrets

- [ ] **BLOCKER** Generate a real session secret and store it in a secrets
      manager, never in a file in the repository:
      ```bash
      openssl rand -base64 32
      ```
- [ ] **BLOCKER** Set `AUTH_SECRET`, `DATABASE_URL` and `APP_URL`. `APP_URL`
      must be the canonical HTTPS origin — the startup gate refuses HTTP and
      localhost.
- [ ] Set `BILLING_WEBHOOK_SECRET` if plans are sold. Without it, no plan change
      can be applied, and the startup gate warns.
- [ ] Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` if AI is enabled. With neither,
      the deterministic offline engine runs and no CRM content leaves the
      deployment. **Decide this deliberately** — see `docs/THREAT-MODEL.md` §7.
- [ ] Confirm no secret is committed: `.env*` is git-ignored and CI runs a
      secret scan over the full history on every push.
- [ ] Write down how `AUTH_SECRET` gets rotated and who can do it. Rotating it
      invalidates every session, which is the point, but it should be a decision
      rather than a surprise.

## 3. Configuration gate

- [ ] **BLOCKER** Run the gate against the real production environment before
      routing traffic:
      ```bash
      NODE_ENV=production npm run check:config
      ```
      It exits non-zero and lists **every** problem — not one per deploy. The
      same check runs at boot (`src/instrumentation.ts`), so a misconfigured
      server refuses to start rather than serving requests insecurely.
- [ ] Confirm these are **unset** in production: `ALLOW_DEMO_AUTH`,
      `SEED_ALLOW_PRODUCTION`, `TINYCRM_TEST_IDENTITY`.
- [ ] Read the startup warnings. They are not fatal but each one names a real
      gap (`RATE_LIMIT_REDIS_URL`, `BILLING_WEBHOOK_SECRET`).

## 4. Transport and platform

- [ ] **BLOCKER** TLS in front of the app, with HTTP redirected to HTTPS.
- [ ] **BLOCKER** A CDN or WAF in front of the origin. Network-layer denial of
      service is explicitly out of scope for the application
      (`docs/THREAT-MODEL.md` §8).
- [ ] Verify the security headers actually arrive — a proxy can strip them:
      ```bash
      curl -sI https://your-domain/ | grep -iE 'content-security|strict-transport|x-frame|x-content-type|referrer|permissions'
      ```
- [ ] Decide on HSTS preloading. The app sends `Strict-Transport-Security`
      without `preload` deliberately: preloading is a one-way door and belongs
      to whoever owns the domain, not to a framework config.

## 5. Rate limiting

- [ ] **Declare `APP_INSTANCES`.** A process cannot see its siblings, and this is
      what decides whether an in-process limiter is a control or a decoration.
      **The production gate refuses to start with `APP_INSTANCES > 1` and no
      shared store**, so getting this wrong fails loudly rather than silently.

- [ ] **BLOCKER for more than one instance** Pick a shared backend:
      - `RATE_LIMIT_REDIS_URL` + `RATE_LIMIT_REDIS_TOKEN` — preferred. No write
        load on the primary, and it stays cheap under an attack.
      - `RATE_LIMIT_BACKEND=postgres` — a genuinely distributed limiter using the
        database you already have, at the cost of a write per check. This is the
        one this repository's tests verify.

- [ ] Note the deliberate choice: a store outage **fails open** and logs at error
      level. Locking every customer out because Redis blinked is worse than the
      window it opens, and account lockout is an independent control that does
      not depend on this store.

## 6. Backup and recovery

- [ ] **BLOCKER** Automated daily backups with point-in-time recovery. Use the
      database host's mechanism — Tiny CRM provides none of its own.
- [ ] **BLOCKER** Restore one, into a scratch database, and sign in against it.
      An untested backup is a hypothesis. Write down how long it took; that is
      your real RTO.

      `npm run test:backup` performs this drill against a local PostgreSQL and
      checks row counts, a content fingerprint, every foreign key, a
      contact → company → deal → stage → workspace walk, cross-tenant bleed and
      the tenant-isolation suite. **It has never been run against a managed
      provider's PITR or `pg_dump` format** — that is the part only you can do,
      and it is the single highest-value hour before launch.

      A logical restore must defer constraints, because of the circular foreign
      key described in §1:
      ```sql
      BEGIN; SET CONSTRAINTS ALL DEFERRED; \i dump.sql COMMIT;
      ```
- [ ] Record the targets you can actually meet, not aspirational ones:
      - **RPO** (data you can afford to lose): with PITR on a managed host,
        typically under 5 minutes.
      - **RTO** (time to be serving again): measure it. A restore plus a redeploy
        is realistically 30–60 minutes for a small deployment.
- [ ] Confirm backups are encrypted and retained somewhere the application role
      cannot delete them.
- [ ] Schedule the restore drill to repeat. Quarterly is a reasonable floor.

## 7. Observability

- [ ] Ship structured logs somewhere queryable. The app emits JSON in
      production, one line per event, each carrying a request id
      (`src/lib/logger.ts`).
- [ ] Wire an error tracker into `onRequestError` in `src/instrumentation.ts` —
      the hook exists and is currently unconnected.
- [ ] Point uptime checks at `/api/health` (liveness, always cheap) and
      `/api/ready` (readiness, touches the database). Use `/api/ready` for
      load-balancer health so an instance with a broken database connection is
      taken out of rotation.
- [ ] **BLOCKER before customers** Set `ALERT_WEBHOOK_URL`. The alert *kinds*
      exist and fire — repeated sign-in failures, lockouts, role escalation,
      owner change, mass export, workspace deletion, webhook signature failures,
      dead-lettered jobs — and without a sink they are written to a table and
      logged, and nobody is woken. Slack, Discord, PagerDuty and Opsgenie all
      accept the JSON POST it sends.

      The payload carries a kind, a severity, a count and an id — never CRM
      content. Whoever receives it looks the rest up somewhere with access
      control; an alerting channel usually has none.

- [ ] Set `ALERT_MIN_SEVERITY`. `warning` is the sensible floor; `info` will
      include routine password resets.

## 8. Background work

- [ ] **Deploy the worker.** Without one, automations fire only when a request
      happens to drain the outbox, and nothing sweeps expired sessions, tokens,
      rate-limit counters or scheduled workspace deletions.

      Three shapes, documented with their trade-offs at the top of
      `scripts/worker.ts`:
      - **Dedicated** — `npm run worker` as a long-running process. Lowest
        latency, simplest to reason about, costs an idle process. The right
        default for a small SaaS.
      - **Cron** — `npm run worker -- --once` on a schedule. No idle process;
        latency bounded by the interval.
      - **A queue provider** — worth it once polling the database is itself load,
        not before.

      Several workers are safe: jobs are claimed atomically and a claim expires,
      so two never take the same job and a crash strands nothing.

- [ ] Check the queue after the first day:
      ```sql
      SELECT status, count(*) FROM "DomainEvent" WHERE "processedAt" IS NULL GROUP BY status;
      SELECT name, "lastError" FROM "DomainEvent" WHERE "deadAt" IS NOT NULL;
      ```
      A dead-lettered job is silent work that stopped happening.

## 9. Verify the deploy

Run these against the deployed instance, not locally.

- [ ] Health: `curl -s https://your-domain/api/health` → `"status":"ok"`.
- [ ] Readiness: `curl -s https://your-domain/api/ready` → `"ready":true`.
- [ ] Signed-out redirect: `curl -sI https://your-domain/deals` → `307` to
      `/login`, not a 500.
- [ ] Sign up, create a workspace, create a contact, archive it, restore it.
- [ ] Create a second account with no shared workspace and confirm it cannot see
      the first one's records.
- [ ] Confirm an export downloads and is audited.
- [ ] Confirm `X-Powered-By` is absent and `/api/*` responses carry
      `Cache-Control: no-store`.

## 10. Before inviting anyone else

These are not deployment steps; they are the things that make a multi-user
deployment defensible.

- [ ] **Configure a mail provider** (`MAIL_PROVIDER_URL`, `MAIL_PROVIDER_TOKEN`).
      Without one there is no password reset and no email verification — and the
      verification gate is *not enforced*, because enforcing a check nobody can
      satisfy would lock every account out of exports and invitations.
- [ ] Send yourself a reset and a verification link, and confirm both arrive.
      The no-provider fallback deliberately logs that a message *would* have been
      sent **without the link**, so a broken configuration is quiet rather than
      dangerous.
- [ ] Understand that **MFA is not enforced at sign-in**. Enrolment works;
      the sign-in challenge does not exist. Do not tell customers they have
      two-factor protection.
- [ ] A security contact in `SECURITY.md` at the repository root, with a
      response-time commitment you can meet.
- [ ] A privacy notice covering what is stored, for how long, and the fact that
      CRM content is sent to an AI provider when one is configured.
- [ ] A data-processing agreement with that AI provider if you are holding other
      people's client data.

---

## Commands, in order

```bash
# 1. Point at PostgreSQL and prepare the schema
npm run db:use-postgres
npx prisma generate
npx prisma migrate deploy
psql "$DATABASE_URL" -f prisma/postgres/001_search_indexes.sql

# 2. Prove the configuration before routing traffic
NODE_ENV=production npm run check:config

# 3. Prove the build and the suite
npm ci
npm run typecheck
npm run lint
npm test                        # SQLite
npm run test:pg                 # real PostgreSQL, including row-level security
npm run test:backup             # back up, destroy, restore, verify
npm run audit:deps              # installed vs loaded, with evidence
npm run build

# 4. Optional but recommended before a release
npm run test:perf              # 25k contacts / 100k activities
npm run test:perf -- --tier=xl # 100k contacts / 500k activities
npm audit --omit=dev

# 5. After deploying
curl -s https://your-domain/api/health
curl -s https://your-domain/api/ready
curl -sI https://your-domain/deals   # expect 307 -> /login
```

---

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | **Yes** | Must be `postgresql://` in production; the gate refuses SQLite |
| `AUTH_SECRET` | **Yes** | ≥32 characters, not the development value |
| `APP_URL` | **Yes** | Canonical HTTPS origin; the gate refuses HTTP and localhost |
| `APP_INSTANCES` | Yes, if > 1 | The gate refuses an in-process limiter above one instance |
| `RATE_LIMIT_REDIS_URL` | Strongly recommended | Or `RATE_LIMIT_BACKEND=postgres`. Without either, limiting is per-instance |
| `MAIL_PROVIDER_URL` / `_TOKEN` | Before inviting anyone | Without them: no password reset, no verification, and the verification gate is off |
| `ALERT_WEBHOOK_URL` | Before customers | Without it, alerts are recorded and nobody is woken |
| `SENTRY_DSN` / `OTEL_EXPORTER_OTLP_ENDPOINT` / `LOG_DRAIN_URL` | Recommended | Without any, exceptions go to logs only |
| `AI_ENTERPRISE_AGREEMENT` | Only if true | Never inferred. "Private model only" workspaces fail closed until set |
| `REQUIRE_MALWARE_SCAN` | If uploads are enabled | Fails uploads closed until a scanner exists |
| `BILLING_WEBHOOK_SECRET` | If selling plans | Without it, no plan change can be applied |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | If AI is enabled | Absent → the offline engine; no CRM content leaves the deployment |
| `AI_PROVIDER` | No | `anthropic` (default) \| `openai` \| `offline` |
| `DATABASE_POOL_MAX` | No | Default 10 per instance |
| `STORAGE_DRIVER` | No | `none` (default) \| `local` \| `s3`. Uploads are disabled at `none` |
| `REQUIRE_MALWARE_SCAN` | No | Fails uploads closed until a scanner is wired in |
| `ALLOW_DEMO_AUTH` | **Never in production** | The gate refuses to boot |
| `SEED_ALLOW_PRODUCTION` | **Never in production** | The gate refuses to boot |
| `TINYCRM_TEST_IDENTITY` | **Never in production** | Authentication bypass; the gate refuses to boot |
