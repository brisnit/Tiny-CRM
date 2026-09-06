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
- [ ] **BLOCKER** Apply the PostgreSQL-only search indexes:
      ```bash
      psql "$DATABASE_URL" -f prisma/postgres/001_search_indexes.sql
      ```
      Substring search compiles to `ILIKE '%term%'` on PostgreSQL, which a btree
      index cannot serve. Without the `pg_trgm` GIN indexes, search degrades to a
      sequential scan once a workspace passes a few thousand rows. `CREATE INDEX
      CONCURRENTLY` cannot run inside a transaction — use `psql -f`, not a
      migration runner.
- [ ] **BLOCKER** Do **not** run `npm run db:seed`. It creates demo workspaces,
      demo companies and a known account. It refuses to run in production
      without `SEED_ALLOW_PRODUCTION`, and the startup gate refuses to boot if
      that variable is set — both guards should stay untouched.
- [ ] Grant the application role `INSERT` and `SELECT` only on `AuditLog`:
      ```sql
      REVOKE UPDATE, DELETE ON "AuditLog" FROM tinycrm_app;
      ```
      The application never updates or deletes audit rows; this makes that
      enforceable rather than merely intended.
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

- [ ] **BLOCKER for more than one instance** Set `RATE_LIMIT_REDIS_URL`.
      The default store is in-memory: per-instance, and it resets on every
      deploy. On a horizontally scaled deployment an attacker gets N times the
      limit. `RateLimitStore` in `src/lib/rate-limit.ts` is the seam; a Redis
      store is a drop-in replacement.

## 6. Backup and recovery

- [ ] **BLOCKER** Automated daily backups with point-in-time recovery. Use the
      database host's mechanism — Tiny CRM provides none of its own.
- [ ] **BLOCKER** Restore one, into a scratch database, and sign in against it.
      An untested backup is a hypothesis. Write down how long it took; that is
      your real RTO.
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
- [ ] Alert on: sign-in failure spikes, lockouts, `data.exported` audit events,
      `member.role_changed`, `workspace.deleted`, and 5xx rate. **None of these
      alerts exist yet** — the audit events they would read from do.

## 8. Background work

- [ ] Schedule `dispatchPendingEvents()` (`src/lib/events.ts`). Today events are
      drained in-process after each request on a best-effort basis; a request
      that fails to drain leaves its events in the outbox. A cron every minute
      is enough, and the function is written to be safe to run concurrently.
- [ ] Schedule cleanup of expired `IdempotencyKey` rows and, once retention is
      defined, of old `DomainEvent` rows.

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

- [ ] Password reset. The `AuthToken` model exists; the flow does not. Without
      it, a forgotten password means manual intervention.
- [ ] Email verification. Same.
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
npm test
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
| `RATE_LIMIT_REDIS_URL` | Strongly recommended | Without it, rate limiting is per-instance |
| `BILLING_WEBHOOK_SECRET` | If selling plans | Without it, no plan change can be applied |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | If AI is enabled | Absent → the offline engine; no CRM content leaves the deployment |
| `AI_PROVIDER` | No | `anthropic` (default) \| `openai` \| `offline` |
| `DATABASE_POOL_MAX` | No | Default 10 per instance |
| `STORAGE_DRIVER` | No | `none` (default) \| `local` \| `s3`. Uploads are disabled at `none` |
| `REQUIRE_MALWARE_SCAN` | No | Fails uploads closed until a scanner is wired in |
| `ALLOW_DEMO_AUTH` | **Never in production** | The gate refuses to boot |
| `SEED_ALLOW_PRODUCTION` | **Never in production** | The gate refuses to boot |
| `TINYCRM_TEST_IDENTITY` | **Never in production** | Authentication bypass; the gate refuses to boot |
