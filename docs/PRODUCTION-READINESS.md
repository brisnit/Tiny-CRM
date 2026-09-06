# Production readiness scorecard

Assessed 2026-09-06, after the hardening pass. 204 automated tests, 15 end-to-end checks.

**GREEN** — implemented, tested, and I would ship it.
**YELLOW** — implemented and works, but has a named gap that matters at scale or
under an incident.
**RED** — not implemented, or implemented in a way that should not carry real
customer data.

This scorecard is written to expose weaknesses, not to look good. A GREEN row
names the test that earns it; a YELLOW or RED row names what is missing and what
it would take.

---

## Summary

| | Count |
|---|---|
| 🟢 GREEN | 14 |
| 🟡 YELLOW | 8 |
| 🔴 RED | 5 |

**Overall: 72 / 100 — not ready for paying customers holding third-party
confidential data; ready for a single-operator deployment of your own data.**

The difference between those two sentences is the five RED rows. Four of them
are not code problems: no verified backup restore, no password reset, no email
verification, no alerting. The fifth — rate limiting that only works on one
instance — is a fifty-line file and a Redis URL.

---

## Application security

| # | Area | Grade | Evidence / gap |
|---|---|---|---|
| 1 | **Tenant isolation** | 🟢 GREEN | One chain (`user → membership → resources`) in `src/lib/auth/access.ts`. 33 tenant-escape tests across reads, writes, relations, bulk, export, import and every AI path. `assertRelations()` closes the whole class of "validated the row, trusted the foreign key". |
| 2 | **Authorization / RBAC** | 🟢 GREEN | One grants table, 5 roles × 18 permissions, enforced server-side inside the action wrapper before any handler body. The matrix is asserted exhaustively against an independently written expectation. |
| 3 | **Input validation** | 🟢 GREEN | Zod at every boundary, inside the error boundary. Ids, URLs, money, dates, text lengths, batch sizes, page sizes. `LIMITS` is the single source of every bound. |
| 4 | **Mass assignment** | 🟢 GREEN | Update schemas omit `workspaceId`; unknown keys stripped; every write names its columns. No `data: body` in the codebase. |
| 5 | **Stored XSS / output safety** | 🟢 GREEN | Allowlist sanitisation on write, 21 evasion payloads tested. CSV formula injection neutralised. Filenames stripped. |
| 6 | **SQL injection** | 🟢 GREEN | Prisma with parameter binding throughout; the only raw SQL is `SELECT 1` in the health probes. |
| 7 | **Destructive-action safety** | 🟢 GREEN | Type-the-name confirmation verified server-side, not in the dialog. Archive-and-restore for every record type. Workspace is the only cascade root; everything below is `SetNull`, so deleting a company detaches history rather than erasing it. |
| 8 | **Concurrency** | 🟢 GREEN | `version` in the `WHERE` clause; a stale write returns `conflict` rather than silently winning. |
| 9 | **Transactions** | 🟢 GREEN | Every multi-row operation is atomic, including the outbox event, so an event can never describe a change that rolled back. |
| 10 | **Error handling** | 🟢 GREEN | Eight categories, safe messages, request id for correlation. No stack, SQL, path or provider response reaches a client. |
| 11 | **Audit log** | 🟢 GREEN | Append-only by construction, metadata redacted, entries outlive the workspace they describe. Covers auth, roles, records, exports, imports, AI-applied changes, plan changes. |
| 12 | **Configuration gate** | 🟢 GREEN | Production refuses to start on a weak secret, demo auth, SQLite, non-HTTPS, seed override or the test-identity hook. Reports every problem at once. Each case tested by launching a real process. |
| 13 | **Demo-data safety** | 🟢 GREEN | The seed refuses any non-SQLite database and any production `NODE_ENV`, at import time, before the client connects. Its refusal does not echo credentials. |
| 14 | **AI security** | 🟢 GREEN | Authorization never touches the model: scope resolved from the session before generation, retrieval filtered to it, record summaries scoped to the record's own workspace. The model has no write capability — proposals require explicit approval, and approval re-validates every id. |

## Infrastructure and operations

| # | Area | Grade | Evidence / gap |
|---|---|---|---|
| 15 | **Authentication** | 🟡 YELLOW | bcrypt cost 12 with transparent rehash, constant-time comparison, lockout, dual-axis rate limits, generic errors, no enumeration on either sign-in or sign-up. **Gap: no MFA, and a stolen JWT is valid for up to 14 days — there is no session revocation list.** |
| 16 | **Rate limiting** | 🔴 RED | Fourteen named policies behind a clean `RateLimitStore` interface, and the default store is **in-memory**: per-instance, resets on deploy. On more than one instance an attacker gets N times the limit. **Fix: implement the Redis store and set `RATE_LIMIT_REDIS_URL`.** Half a day. |
| 17 | **Secrets management** | 🟡 YELLOW | Nothing committed; `.env*` ignored; history scanned; secret scan in CI. **Gap: no rotation procedure, and rotating `AUTH_SECRET` signs everyone out with no warning path.** |
| 18 | **Security headers** | 🟡 YELLOW | CSP, HSTS, frame-deny, nosniff, referrer and permissions policies, `X-Powered-By` removed. **Gap: `style-src 'unsafe-inline'` remains, because Next.js and Recharts both emit inline styles. A nonce-based CSP is possible and is real work.** |
| 19 | **Database integrity** | 🟢 GREEN | Foreign keys throughout, compound uniqueness where it matters, indexes on every access path the app actually uses, 53 relations set to `SetNull` so deletion detaches rather than destroys. |
| 20 | **PostgreSQL portability** | 🟡 YELLOW | Schema is provider-agnostic by contract; `prisma validate` and the full DDL generate cleanly for PostgreSQL; the one genuine behavioural difference (case-sensitive `LIKE`) is fixed and the required `pg_trgm` indexes ship. **Gap: I could not run the suite against a live PostgreSQL here — no server and no Docker on this machine. CI has a `test-postgres` job that does exactly that; it has never been executed. Until it goes green, portability is argued, not proven.** |
| 21 | **Performance at scale** | 🟢 GREEN | Measured, not asserted. At 100,000 contacts / 50,000 deals / 500,000 activities, every screen query is under 260 ms warm; at 25k/100k, under 40 ms. `npm run test:perf` fails the build on a budget breach. |
| 22 | **Backups and recovery** | 🔴 RED | **Nothing exists.** No backup mechanism, no restore procedure, no drill, no measured RPO or RTO. The checklist says to use the database host's PITR and to restore one before launch. **Until a restore has actually been performed, there is no evidence this data is recoverable.** |
| 23 | **Observability** | 🔴 RED | Structured JSON logs with request ids, redaction, health and readiness endpoints, and an `onRequestError` hook — all of which are integration *points*. **Nothing is connected: no log destination, no error tracker, no dashboard, no alert on a failed sign-in spike, a bulk export, a role change or a workspace deletion.** The audit events those alerts would read from do exist. |
| 24 | **Background processing** | 🟡 YELLOW | Outbox pattern with atomic claiming, attempt counters and a retry ceiling; safe to run concurrently. **Gap: dispatch is best-effort in-process after a request. Nothing schedules it, so an event whose request died sits in the outbox until something else drains it.** A one-minute cron closes this. |
| 25 | **Billing boundary** | 🟢 GREEN | Plan is webhook-only: HMAC-SHA256 over `timestamp.body`, constant-time, 300-second replay window, idempotent delivery. A test asserts that no browser-reachable plan action exists. |
| 26 | **Dependencies** | 🟡 YELLOW | Lockfile committed, `npm ci` everywhere, audit in CI. **Gap: 4 high advisories, all transitive under the Prisma CLI (`mysql2`, `deepmerge-ts`, `@prisma/config`). Not in the deployed runtime, the MySQL driver is never loaded, and no fix exists in Prisma 7.10.0. Accepted and tracked; re-check each Prisma release.** |
| 27 | **CI/CD** | 🟡 YELLOW | Seven jobs: static checks, tests on SQLite, tests on PostgreSQL, production build plus both directions of the config gate, performance budgets, dependency audit, secret scan. **Gap: written, never run — this repository has no remote yet.** |
| 28 | **File uploads** | 🟡 YELLOW | Disabled in this build (`files` flag off, `STORAGE_DRIVER=none`). The validation that will gate them is implemented and tested: extension allowlist (SVG deliberately excluded), magic bytes checked against the declared type, generated storage keys, `Content-Disposition: attachment` with `nosniff` and a `default-src 'none'` CSP. **Gap: no malware scanner. `scanForMalware()` logs its own absence and fails closed under `REQUIRE_MALWARE_SCAN`.** |
| 29 | **Data retention and privacy** | 🔴 RED | Export exists; workspace deletion is a complete cascade; the audit log deliberately survives it. **Gap: no retention policy, no automated purge, no privacy notice, no data-processing agreement with the AI provider, and no per-workspace opt-out from sending CRM content to that provider.** No compliance claim is made anywhere, which is correct — but a customer will ask. |
| 30 | **Account recovery** | 🔴 RED | **Password reset and email verification do not exist.** The `AuthToken` model and `emailVerifiedAt` column are present and unused; no email is ever sent. A user who forgets their password requires manual database intervention, and no address in the system has been verified. |

---

## Scoring

Weighted by what actually causes incidents, not by row count.

| Dimension | Weight | Score | Weighted |
|---|---|---|---|
| Tenant isolation & authorization | 25 | 24 / 25 | 24 |
| Input, output and write safety | 20 | 20 / 20 | 20 |
| Authentication & account lifecycle | 15 | 8 / 15 | 8 |
| Data integrity & recoverability | 15 | 7 / 15 | 7 |
| Operations: rate limiting, observability, CI | 15 | 6 / 15 | 6 |
| Scale & portability | 10 | 7 / 10 | 7 |
| **Total** | **100** | | **72** |

Authentication loses points for the absent recovery flows and MFA, not for the
implemented parts. Data integrity loses them almost entirely to the unverified
backup: the schema and the write path are strong, and neither matters if the
data cannot be restored.

---

## What would move the score

| Change | Effort | New score |
|---|---|---|
| Redis rate-limit store | ~4 hours | 75 |
| Verified backup restore, RPO/RTO written down | ~4 hours | 80 |
| Password reset + email verification | ~1 day | 86 |
| Log shipping, error tracking, and four alerts | ~1 day | 91 |
| Run the PostgreSQL CI job to green | ~1 hour once a remote exists | 93 |
| MFA and session revocation | ~2 days | 96 |
| PostgreSQL row-level security as a second isolation layer | ~2 days | 98 |

The first two are half a day together and take this from "a prototype that has
been hardened" to "a system whose data survives a mistake."

---

## Verification

Every green row above is reproducible:

```bash
npm test                        # 204 tests: unit, security, integration
npm run test:perf               # 25k contacts / 100k activities, budgeted
npm run test:perf -- --tier=xl  # 100k contacts / 500k activities
npm run typecheck
npm run lint
npm run build
node e2e-verify.mjs             # 15 end-to-end checks against a running app
NODE_ENV=production npm run check:config
```
