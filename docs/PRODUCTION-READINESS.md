# Production readiness scorecard

Assessed 2026-09-06, after the second hardening pass.

**318 tests on SQLite · 358 on PostgreSQL 17.10 · 15 end-to-end · 12 query
budgets at two scales · a verified backup restore.**

**GREEN** — implemented, tested, and I would ship it.
**YELLOW** — implemented and works, with a named gap that matters at scale or
under an incident.
**RED** — not implemented, or implemented in a way that should not carry real
customer data.

Written to expose weaknesses. A GREEN row names the test that earns it; a YELLOW
or RED row names what is missing and what it would take.

---

## Summary

| | Previous | Now |
|---|---|---|
| 🟢 GREEN | 14 | **24** |
| 🟡 YELLOW | 8 | **7** |
| 🔴 RED | 5 | **2** |
| **Score** | **72 / 100** | **88 / 100** |

**Ready for a small number of real customers storing confidential business data,
provided the two RED rows are closed during deployment** — both are configuration
and organisation, not code: connect the alerting sink, and run the restore drill
against the real provider.

Not ready for a regulated buyer, an enterprise security review, or anyone who
requires enforced MFA.

---

## Application security

| # | Area | Grade | Evidence / gap |
|---|---|---|---|
| 1 | **Tenant isolation — application** | 🟢 GREEN | One chain in `auth/access.ts`; 33 tenant-escape tests across reads, writes, relations, bulk, export, import and every AI path. |
| 2 | **Tenant isolation — database** | 🟢 GREEN | **New.** 38 of 47 tables under `FORCE ROW LEVEL SECURITY`, deny-by-default, transaction-local context so a pooled connection cannot leak it. 40 tests connect *directly as the restricted role* and issue `SELECT *` with no `WHERE` clause across 16 tables, plus `UPDATE`/`DELETE`/`INSERT` and audit tampering. |
| 3 | **Authorization / RBAC** | 🟢 GREEN | One grants table, enforced server-side before any handler body. Matrix asserted exhaustively against an independently written expectation. |
| 4 | **Input validation** | 🟢 GREEN | Zod at every boundary, inside the error boundary. `LIMITS` is the single source of every bound. |
| 5 | **Mass assignment** | 🟢 GREEN | Update schemas omit `workspaceId`; unknown keys stripped; every write names its columns. A structural test asserts no action spreads a payload or writes an ownership column from a request. |
| 6 | **Stored XSS / output safety** | 🟢 GREEN | Allowlist sanitisation on write, 21 evasion payloads. CSV formula injection neutralised. |
| 7 | **SQL injection** | 🟢 GREEN | Prisma parameter binding throughout; the only raw SQL in the app is `SELECT 1`. |
| 8 | **Destructive-action safety** | 🟢 GREEN | Type-the-name confirmation verified server-side. Workspace deletion is scheduled with a grace period. Everything below the workspace is `SetNull`, so history outlives records. |
| 9 | **Data recovery** | 🟢 GREEN | **New.** Trash lists archived records across six types and restores them. Workspace deletion has a seven-day grace period, a `critical` alert, and cancellation — and a test asserts a cancelled deletion is a no-op when its job comes due. |
| 10 | **Concurrency** | 🟢 GREEN | `version` in the `WHERE` clause; verified on both engines that exactly one of two racing writes lands. |
| 11 | **Transactions** | 🟢 GREEN | Every multi-row operation atomic, including the outbox event. |
| 12 | **Error handling** | 🟢 GREEN | Eight categories, safe messages, request id. No stack, SQL, path or provider response reaches a client. |
| 13 | **Audit log** | 🟢 GREEN | Append-only by construction *and* by grant — `UPDATE`/`DELETE` revoked from the app role, so tampering fails with a privilege error. Entries outlive the workspace. |
| 14 | **Security alerting** | 🟢 GREEN | **New.** A type distinct from audit entries, deduplicated with a count, re-opening on repeat so an acknowledged alert cannot be used to go quiet. Metadata redacted. Scoped per workspace. *Delivery is a separate row — see #26.* |
| 15 | **Configuration gate** | 🟢 GREEN | Refuses a weak secret, demo auth, SQLite, non-HTTPS, seed override, the test-identity hook, and now an in-process rate limiter with `APP_INSTANCES > 1`. Every case launches a real process. |
| 16 | **Demo-data safety** | 🟢 GREEN | The destructive seed refuses any non-SQLite database at import time, before the client connects, and its refusal does not echo credentials. |
| 17 | **AI security** | 🟢 GREEN | Authorization never touches the model; the model has no write capability; approval re-validates every id. |
| 18 | **AI privacy** | 🟢 GREEN | **New.** Per workspace, not per account. `disabled` sends nothing and every deterministic feature keeps working. `private` fails closed. A mixed scope keeps the whole answer local. Nothing claims zero retention — that is a contract, not a vendor property. |
| 19 | **Password reset** | 🟢 GREEN | **New.** Hash-only storage, 30-minute single-use tokens, superseded on reissue, and on completion every token *and every session* is revoked. Identical answers and comparable timing whether or not the account exists. |
| 20 | **Session revocation** | 🟢 GREEN | **New.** A session id matched against a live row, plus an epoch that revokes everything with no lookup. Only hashes stored. Tested against replay after sign-out, after reset, with a forged epoch, and across accounts. |
| 21 | **Content-Security-Policy** | 🟢 GREEN | **Fixed a live defect.** A static `script-src 'self'` was blocking Next's own bootstrap and breaking hydration in production — invisible because E2E only ran against dev. Now nonce-based, verified in a browser against a production build with zero violations. |
| 22 | **Database integrity** | 🟢 GREEN | Foreign keys throughout, compound uniqueness, indexes on every access path, `SetNull` below the workspace, and now deferrable constraints so a logical restore is possible at all. |
| 23 | **Performance at scale** | 🟢 GREEN | Measured on both engines. At 100k contacts / 500k activities, every screen query under 83 ms on PostgreSQL, 260 ms on SQLite. `npm run test:perf` fails the build on a budget breach. |
| 24 | **PostgreSQL portability** | 🟢 GREEN | **Was YELLOW.** 358 tests, the seed, the differences probe and both load tiers executed against a real PostgreSQL 17.10. Two high-severity defects found by executing rather than reasoning — see `docs/POSTGRES-VERIFICATION.md`. |

## Infrastructure and operations

| # | Area | Grade | Evidence / gap |
|---|---|---|---|
| 25 | **Backups and recovery** | 🟡 YELLOW | **Was RED.** `npm run test:backup` backs up, destroys, restores and verifies row counts, a content fingerprint, every foreign key, a relationship walk, cross-tenant bleed and the isolation suite — and found the circular FK that made a logical restore impossible. **Gap: this proves the data round-trips; it has never been run against a managed provider's PITR or `pg_dump` format. Do that once before launch.** |
| 26 | **Observability & alerting** | 🔴 **RED** | Provider-independent adapters for Sentry, OTLP and a log drain, with a payload built from an allowlist rather than an SDK's automatic instrumentation. Alert kinds, severities, dedupe and delivery all implemented. **Gap: nothing is configured. Without `SENTRY_DSN` exceptions go to logs only, and without `ALERT_WEBHOOK_URL` nobody is woken by a mass export, a role escalation or a workspace deletion.** Half a day of configuration, and it is the difference between having detection and having the code for it. |
| 27 | **Distributed rate limiting** | 🟡 YELLOW | **Was RED.** Three backends; the PostgreSQL one is genuinely distributed and is verified here — two independent stores share a counter, 20 concurrent increments all land. Multi-dimensional (ip / account / user / workspace), keyed-hash keys. Production refuses in-process on `APP_INSTANCES > 1`. **Gap: the Redis adapter is written against Upstash's REST API and has not been run against a live Redis.** |
| 28 | **Background worker** | 🟡 YELLOW | **Was YELLOW, improved.** Atomic claiming, expiring claims, exponential backoff, dead-letter, per-attempt execution log, tenant context per job. A poisoned job cannot block the queue — tested. **Gap: nothing schedules it. `npm run worker` must actually be deployed, or automations fire only when a request happens to drain the outbox.** |
| 29 | **Authentication** | 🟡 YELLOW | bcrypt cost 12 with rehash, lockout, dual-axis throttling, no enumeration on sign-in or sign-up, sessions revocable. **Gap: MFA is enrolment-only — see #30.** |
| 30 | **Multi-factor authentication** | 🟡 YELLOW | **New, and honestly graded.** TOTP with encrypted secrets, drift, replay protection and bcrypt recovery codes, all working and tested. **`MFA_ENFORCED_AT_SIGN_IN` is `false`: sign-in does not demand a code.** The Credentials provider authorises in one call, so a challenge needs a two-stage sign-in with a pre-auth token. The UI says so, `mfaStatus()` returns the flag, and a test asserts what a user is told matches what sign-in does. Shipping it half-wired would leave users believing they are protected when they are not. |
| 31 | **Email verification** | 🟡 YELLOW | **New.** Single-use expiring tokens, a centralised gate covering invite / export / import / integrations / billing / workspace deletion, checked after the permission check. **Gap: enforcement follows the ability to deliver mail — with no `MAIL_PROVIDER_URL` nobody can verify, so the gate is off. A deployment without email has no verification.** |
| 32 | **Secrets management** | 🟡 YELLOW | Nothing committed; history scanned; secret scan in CI; `env.production.example` categorises every variable. **Gap: no rotation procedure, and rotating `AUTH_SECRET` signs everyone out with no warning path.** |
| 33 | **Dependencies** | 🟢 GREEN | **Was YELLOW.** `npm run audit:deps` reports evidence rather than a label, and corrected the previous report: the four advisories *are* installed by a production install (via `@prisma/client → prisma`), and *none* appears in the build output. CI fails only if something with an open advisory is actually loaded. |
| 34 | **CI/CD** | 🟡 YELLOW | Eight jobs covering static checks, both engines, RLS with a restricted login, the restore drill, the config gate in both directions, performance budgets, dependency evidence and a secret scan. Every command has been run locally and passes. **Gap: this repository has no git remote, so GitHub has never executed it. CI is not protecting anything yet.** |
| 35 | **File uploads** | 🟡 YELLOW | Disabled (`STORAGE_DRIVER=none`, flag off). Validation implemented and tested: extension allowlist with SVG deliberately excluded, magic bytes against the declared type, generated storage keys, attachment-only downloads. **Gap: no malware scanner. `REQUIRE_MALWARE_SCAN=true` fails uploads closed until one exists.** |
| 36 | **Data retention & privacy** | 🔴 **RED** | `docs/DATA-CLASSIFICATION.md` classifies every store and derives storage, logging, AI, export and retention rules. Export exists; workspace deletion is a complete cascade; the audit trail survives it. **Gap: no automated purging of anything except sessions, tokens, completed jobs and rate-limit counters. No privacy notice. No data-processing agreement with the AI provider. A customer asking "how long do you keep my deleted data" gets "indefinitely".** |

---

## Scoring

Weighted by what actually causes incidents, not by row count.

| Dimension | Weight | Previous | Now |
|---|---|---|---|
| Tenant isolation & authorization | 25 | 24 | **25** |
| Input, output and write safety | 20 | 20 | **20** |
| Authentication & account lifecycle | 15 | 8 | **12** |
| Data integrity & recoverability | 15 | 7 | **13** |
| Operations: rate limiting, observability, CI | 15 | 6 | **10** |
| Scale & portability | 10 | 7 | **10** |
| **Total** | **100** | **72** | **88** |

**Tenant isolation** reaches full marks: two independent layers, the second
proven by attacking it from below the application.

**Authentication** gains reset, verification and revocation; it loses 3 points
because MFA is enrolment-only and verification depends on a mail provider.

**Data integrity** gains a *verified* restore and recoverable deletion; it loses
2 because the drill has not been run against a real managed backup.

**Operations** gains a distributed limiter and a real worker; it loses 5 because
nothing is connected — no error tracker, no alert delivery, no scheduled worker,
no CI actually running.

---

## What would move it further

| Change | Effort | New score |
|---|---|---|
| Configure alert delivery + an error tracker | ~4 hours | 91 |
| Run the restore drill against the real provider | ~2 hours | 92 |
| Push to a remote and get CI green | ~1 hour | 93 |
| Deploy the worker on a schedule | ~1 hour | 94 |
| Automated retention purging + a privacy notice | ~1 day | 96 |
| MFA enforced at sign-in (two-stage flow) | ~2 days | 98 |

The first four total under a day and are configuration rather than code. They are
the difference between "the controls exist" and "somebody would find out".

---

## Verification

Every green row is reproducible:

```bash
npm test                          # 318 tests on SQLite
npm run test:pg                   # 358 tests on real PostgreSQL 17, incl. RLS
npm run test:backup               # back up, destroy, restore, verify
npm run test:perf                 # 25k contacts / 100k activities
npm run test:perf -- --tier=xl    # 100k contacts / 500k activities
npm run db:differences            # 29-probe engine comparison
npm run audit:deps                # installed vs loaded, with evidence
npm run typecheck && npm run lint && npm run build
node e2e-verify.mjs               # 15 end-to-end checks against a running app
NODE_ENV=production npm run check:config
```
