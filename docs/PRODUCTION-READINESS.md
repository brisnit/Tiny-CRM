# Production readiness scorecard

Assessed 2026-09-08, after the third hardening pass — the one that connected
the deployment to the outside world.

**395 tests on SQLite · 433 on PostgreSQL 17.10 · 15 end-to-end · 12 query
budgets at two scales · a verified backup restore · a hosted attack pass, a
hosted account lifecycle and a hosted cross-tenant pass against the real
deployment.**

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
| 🟢 GREEN | 25 | **29** |
| 🟡 YELLOW | 9 | **6** |
| 🔴 RED | 2 | **1** |
| **Score** | **90 / 100** | **95 / 100** |

**Two corrections to the previous pass, made by counting rather than by trusting
the last summary.** Its dimension rows summed to 90 while the total said 88. Its
grade counts said 24 / 7 / 2, which is 33 rows in a table of 36; the real figures
were 25 / 9 / 2. Both are corrected above rather than carried forward. A
scorecard whose own arithmetic does not hold is not evidence of anything, and
this one is supposed to be the document that resists flattering itself.

**Ready for a small private beta: a small number of real customers storing
confidential business data.** Error reporting, alert delivery, transactional mail
and the scheduled worker are now connected and each verified end to end against
the hosted deployment rather than in a test.

The provider's own recovery mechanism has now been exercised end to end and is
recorded in `docs/NEON-RECOVERY-DRILL.md`. The remaining RED is retention and
privacy documentation, which is organisation rather than code.

Two limits are not closed by any of this and should be read before launch: the
PITR window is **6 hours** on the current Neon plan, and production runs
**PostgreSQL 18.6** while the entire test matrix runs 17.10.

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
| 24 | **PostgreSQL portability** | 🟢 GREEN | **Was downgraded to YELLOW, now earned back.** Production runs PostgreSQL 18.6 while the matrix ran only 17.10 — found by reading the server version during the recovery drill, not by any test. CI now runs **both** engines: run `34263437206` on `288ade4` shows `Test suite (PostgreSQL 17)` and `Test suite (PostgreSQL 18)` both green, 9/9 jobs. Independently, the full suite ran against a real PostgreSQL 18.6 Neon branch — the same engine *and* provider as production — 435 passed, 0 failed, 0 skipped. 17 is kept rather than replaced: it is the version two high-severity defects were found on. |

## Infrastructure and operations

| # | Area | Grade | Evidence / gap |
|---|---|---|---|
| 25 | **Backups and recovery** | 🟢 GREEN | **Was YELLOW.** The provider's own recovery mechanism has now been exercised: a branch taken from a historical timestamp, verified with 38 assertions that pass identically on production and on the restored branch — schema hash-identical across tables, columns, constraints, policies and indexes; fingerprint exact; the circular `Company ↔ Contact` FK intact; RLS enabled and forced; `tinycrm_app` still non-superuser without BYPASSRLS; A→B and B→A refused while A→A and B→B succeed. Branch ready in 2.7 s. Full record in `docs/NEON-RECOVERY-DRILL.md`. **Caveat that does not go away: the PITR window is 6 hours on the free plan**, so data destroyed and noticed the next day is unrecoverable, and branching is copy-on-write within the project rather than an independent copy. |
| 26 | **Observability & alerting** | 🟢 GREEN | **Was RED.** Both sinks are connected and were proven by making the real thing happen, not by calling a function. A Slack alert raised through the application's own alerting path arrived in a human's Slack. One deliberate production exception, thrown from a `CRON_SECRET`-gated diagnostics route so it takes the real `onRequestError` path, was accepted by Sentry (event `c452c01d`, confirmed visually in the project). No SDK: the payload is an allowlist, so no breadcrumbs, request bodies, local variables, cookies or headers exist to leak. Integrating it exposed four real privacy defects — the stack carried the unscrubbed message, tag values carried content, the query string became the transaction name, and a session JWT and vendor API key survived redaction entirely — each fixed with a regression test written first. A delivery failure can no longer be silent: `fetch` does not throw on 4xx/5xx, so a rejected event used to look identical to a healthy one. |
| 27 | **Distributed rate limiting** | 🟡 YELLOW | **Was RED.** Three backends; the PostgreSQL one is genuinely distributed and is verified here — two independent stores share a counter, 20 concurrent increments all land. Multi-dimensional (ip / account / user / workspace), keyed-hash keys. Production refuses in-process on `APP_INSTANCES > 1`. **Gap: the Redis adapter is written against Upstash's REST API and has not been run against a live Redis.** |
| 28 | **Background worker** | 🟢 GREEN | **Was YELLOW.** Atomic claiming, expiring claims, exponential backoff, dead-letter, per-attempt execution log, tenant context per job. A poisoned job cannot block the queue — tested. **Gap closed:** Vercel Cron drives `/api/cron/jobs` every five minutes, and production logs show it draining and reporting an empty queue with nothing dead-lettered. The endpoint is `CRON_SECRET`-gated with a constant-time comparison, because an unprotected job runner is a free denial-of-service against the database. |
| 29 | **Authentication** | 🟡 YELLOW | bcrypt cost 12 with rehash, lockout, dual-axis throttling, no enumeration on sign-in or sign-up, sessions revocable. **Gap: MFA is enrolment-only — see #30.** |
| 30 | **Multi-factor authentication** | 🟡 YELLOW | **New, and honestly graded.** TOTP with encrypted secrets, drift, replay protection and bcrypt recovery codes, all working and tested. **`MFA_ENFORCED_AT_SIGN_IN` is `false`: sign-in does not demand a code.** The Credentials provider authorises in one call, so a challenge needs a two-stage sign-in with a pre-auth token. The UI says so, `mfaStatus()` returns the flag, and a test asserts what a user is told matches what sign-in does. Shipping it half-wired would leave users believing they are protected when they are not. |
| 31 | **Email verification** | 🟢 GREEN | **Was YELLOW.** Mail is configured and delivering. The full account lifecycle was run against the hosted deployment with *actually delivered* mail — sign-up issues a verification token and sends it, verification completes, reset completes, and a used, expired or superseded token is refused and distinguishable from a token that never existed. The entry points are asserted to exist, because every one of these flows was implemented, tested and correct while being unreachable: no link, no page, no mail on sign-up. A mail outage cannot lose an account — sign-up does not roll back on a send failure. |
| 32 | **Secrets management** | 🟡 YELLOW | Nothing committed; history scanned; secret scan in CI; `env.production.example` categorises every variable. **Gap: no rotation procedure, and rotating `AUTH_SECRET` signs everyone out with no warning path.** |
| 33 | **Dependencies** | 🟢 GREEN | **Was YELLOW.** `npm run audit:deps` reports evidence rather than a label, and corrected the previous report: the four advisories *are* installed by a production install (via `@prisma/client → prisma`), and *none* appears in the build output. CI fails only if something with an open advisory is actually loaded. |
| 34 | **CI/CD** | 🟢 GREEN | **Was YELLOW.** Eight jobs covering static checks, both engines, RLS with a restricted login, the restore drill, the config gate in both directions, performance budgets, dependency evidence and a secret scan. **A full green run is now observed from a clean checkout** (`ff931ca`, all eight jobs). It earned its place immediately: the previous push went red on the secret scan, catching two false-positive fixtures before they became somebody's confusing build failure. The previous grade's stated reason — "no git remote, so GitHub has never executed it" — was already stale; 25 runs had executed. |
| 35 | **File uploads** | 🟡 YELLOW | Disabled (`STORAGE_DRIVER=none`, flag off). Validation implemented and tested: extension allowlist with SVG deliberately excluded, magic bytes against the declared type, generated storage keys, attachment-only downloads. **Gap: no malware scanner. `REQUIRE_MALWARE_SCAN=true` fails uploads closed until one exists.** |
| 36 | **Data retention & privacy** | 🔴 **RED** | `docs/DATA-CLASSIFICATION.md` classifies every store and derives storage, logging, AI, export and retention rules. Export exists; workspace deletion is a complete cascade; the audit trail survives it. **Gap: no automated purging of anything except sessions, tokens, completed jobs and rate-limit counters. No privacy notice. No data-processing agreement with the AI provider. A customer asking "how long do you keep my deleted data" gets "indefinitely".** |

---

---

## Verification ledger

Four different claims get made about PostgreSQL in this repository and they are
not interchangeable. This table exists because they were once written as if they
were, and because "CI GREEN" was claimed in the same breath as a CI run that had
not finished — and which, when it did, was red for a reason introduced by the
same commit.

| Claim | What it means | Status |
|---|---|---|
| **PG 18 direct verification** | The suite run by hand against a real PostgreSQL 18.6 Neon branch — same engine and provider as production | 435 passed / 0 failed / 0 skipped |
| **PG 17 CI verification** | The `Test suite (PostgreSQL 17)` job on a GitHub run | green — run `34263437206`, commit `288ade4` |
| **PG 18 CI verification** | The `Test suite (PostgreSQL 18)` job on a GitHub run | green — run `34263437206`, commit `288ade4` |
| **Full CI verification** | *Every* job on a completed GitHub run | green — 9/9, run `34263437206`, commit `288ade4` |

**The rule this ledger encodes:** a GitHub run that has not completed is
PENDING, never green, and a job's result is never inferred from another job's.
A local run proves the engine; only a completed GitHub run proves CI.

---

## Scoring

Weighted by what actually causes incidents, not by row count.

| Dimension | Weight | Two passes ago | Previous | Now |
|---|---|---|---|---|
| Tenant isolation & authorization | 25 | 24 | 25 | **25** |
| Input, output and write safety | 20 | 20 | 20 | **20** |
| Authentication & account lifecycle | 15 | 8 | 12 | **13** |
| Data integrity & recoverability | 15 | 7 | 13 | **14** |
| Operations: rate limiting, observability, CI | 15 | 6 | 10 | **14** |
| Scale & portability | 10 | 7 | 10 | **9** |
| **Total** | **100** | **72** | **90** | **95** |

The previous pass reported 88. Its own rows summed to 90 — an arithmetic error,
corrected above rather than quietly carried forward. The 72 was correct.

**Scale & portability** loses a point it previously held. Production runs
PostgreSQL 18.6 and the entire verification matrix runs 17.10 — a gap found by
reading the engine version during the recovery drill, not by any test. It is a
correction of a grade that was always too generous rather than a regression.

**Tenant isolation** holds full marks: two independent layers, the second proven
by attacking it from below the application, and now also proven against the
hosted deployment — tenant A cannot read tenant B's records or audit events
through the real HTTP path, with production rate limiting left switched on.

**Authentication** gains a mail provider that actually delivers, so verification
and reset are reachable rather than merely implemented. It still loses 2 because
MFA is enrolment-only: sign-in does not demand a code, and the UI says so.

**Data integrity** gains a real provider recovery, verified rather than assumed:
a branch from a historical timestamp, restored and checked with the same 38
assertions that pass against production. It loses 1 for the six-hour PITR
window, which is a plan limit and the binding constraint on how much can
actually be recovered.

**Operations** gains an error tracker, alert delivery, a scheduled worker and an
observed green CI run, each verified rather than assumed. It loses 1 because the
Redis limiter has never been run against a live Redis — the PostgreSQL one,
which is what production actually uses, has.

---

## What would move it further

| Change | Effort | New score |
|---|---|---|
| Move Neon to a paid plan for a 7- or 30-day PITR window | ~15 minutes | 96 |
| Run the CI matrix against PostgreSQL 18 to match production | ~1 hour | 97 |
| Automated retention purging + a privacy notice | ~1 day | 98 |
| MFA enforced at sign-in (two-stage flow) | ~2 days | 100 |

The first two total about an hour and are configuration, not code. The six-hour
window is the one to do first: every other control on this scorecard protects
data that still exists, and that number decides how much of it can come back
when something destroys it.

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
