# Threat model

What Tiny CRM holds, who would want it, how they would try to get it, and what
stops them. Where nothing stops them, this says so.

Companion to `docs/SECURITY.md`, which describes controls;
this document describes attacks.

---

## 1. What is being protected

Tiny CRM is a multi-tenant CRM for a person or small team running several
businesses at once. A single workspace can hold:

| Asset | Sensitivity | Why an attacker wants it |
|---|---|---|
| Contact records | High | Names, work emails, phone numbers, employers — directly usable for phishing the customer's own clients |
| Company records | Medium | Who the business works with; competitive intelligence |
| Deals with values and stages | High | Revenue, pipeline, win rates; useful to a competitor, and to anyone pricing against them |
| RFP / opportunity records | High | Solicitation numbers, deadlines, requirements, bid strategy — timed leverage in a competitive process |
| Notes | High | Free text. In practice the most sensitive store in the product: candid assessments of clients and staff, pricing floors, personal detail |
| Files | High | Proposals, contracts, anything uploaded |
| Investor information | High | Cap-table-adjacent, market-moving for a private company |
| AI summaries | High | Compressed versions of everything above, and easier to exfiltrate than the source |
| Audit log | Medium | Attacker's own trail; the thing to delete after a breach |
| Password hashes | High | Credential reuse against the user's other accounts |
| Session tokens | Critical | Instant full access |
| Provider API keys | Critical | Billable, and a pivot into the AI provider account |

**The single worst outcome is cross-tenant disclosure.** The product's premise is
that one person runs several businesses in one account and that a workspace
separates them. If workspaces leak into each other, the product is not merely
buggy — its central promise is false.

---

## 2. Trust boundaries

```
┌─ Untrusted ───────────────────────────────────────────────────────┐
│  Browser · request bodies · query strings · cookies · CSV files   │
│  uploaded documents · CRM content typed by third parties          │
│  model output · webhook deliveries                                │
└───────────────────────────────┬───────────────────────────────────┘
                                │  ← src/proxy.ts (redirect only, not a control)
┌───────────────────────────────▼───────────────────────────────────┐
│  Server                                                           │
│    src/lib/auth/access.ts   ← the authorization boundary          │
│    src/lib/actions/base.ts  ← the write boundary                  │
│    src/lib/validation/      ← the input boundary                  │
│    src/lib/sanitize.ts      ← the output boundary                 │
└───────────┬───────────────────────────────────┬───────────────────┘
            │                                   │
┌───────────▼───────────┐          ┌────────────▼──────────────────┐
│  Database             │          │  AI provider (external)       │
│  one workspaceId per  │          │  receives a bounded context   │
│  row; no RLS          │          │  slice; see §7                │
└───────────────────────┘          └───────────────────────────────┘
```

Three things are **inside** the trust boundary that people often assume are
outside, and are worth stating plainly:

1. **Every export of a `"use server"` module is a public HTTP endpoint**,
   whether or not the UI calls it. An unexported helper is private; an exported
   one is an API. This is how the worst finding of the original audit arose: a
   `createWorkspaceWithDefaults(userId, …)` helper was exported from an action
   module and could therefore provision a workspace for any user, unauthenticated.
   Server-only helpers now live in `server-only` modules with no `"use server"`
   directive.
2. **CRM content is attacker-controlled.** A company name is typed by a human,
   possibly a hostile one, and is later rendered, exported to CSV, and fed to a
   language model.
3. **Model output is untrusted input**, especially after it round-trips through
   a browser for user approval.

---

## 3. Adversaries

| # | Adversary | Capability | Motivation |
|---|---|---|---|
| A1 | **Anonymous internet** | Unauthenticated HTTP to any endpoint | Opportunistic: credential stuffing, scanning, resource abuse |
| A2 | **Legitimate user, other tenant** | Valid account, no membership in the target workspace | Competitive intelligence; the primary threat to the product's core promise |
| A3 | **Legitimate user, lower role** | Valid membership as viewer or member | Privilege escalation; bulk extraction on the way out |
| A4 | **Departing insider** | Valid membership, possibly admin | Take the customer list to a new employer |
| A5 | **Hostile third party in the data** | Can get text into the CRM (a company name, an inbound email, an imported CSV) | Prompt injection; XSS; CSV formula injection |
| A6 | **Compromised dependency** | Arbitrary code in the build or runtime | Anything |
| A7 | **Platform / provider** | Hosting provider, database host, AI provider | Not defended against; accepted (§8) |

---

## 4. Attack scenarios

Each row states the attack, what stops it, and where that is proven.

### A2 — cross-tenant access (the critical path)

| Attack | Control | Proof |
|---|---|---|
| Read another workspace's records by id | Every read is filtered by `workspaceId IN (memberships)`; `requireRecordAccess` has no calling form that reads outside the tenant | `tenant-isolation.test.ts` |
| Pass another workspace's id as `workspaceId` in a body | The id only *selects* among the caller's memberships; a non-member id is indistinguishable from a non-existent one | `tenant-isolation.test.ts` |
| Attach own record to a foreign contact / company / project / pipeline stage | `assertRelations()` on every mutating action, including stages reached through their pipeline | `tenant-isolation.test.ts` (8 relation cases) |
| Move a deal onto a foreign stage by drag-and-drop | `moveDealToStage` validates the stage through the deal's own pipeline | `tenant-isolation.test.ts` |
| Bulk-complete tasks including foreign ids | `updateMany` carries the workspace filter; foreign ids match nothing rather than being reported | `tenant-isolation.test.ts` |
| Export another workspace's data | Export is bound to one workspace, requires `record:export`, and is audited | `tenant-isolation.test.ts` |
| Import into another workspace | `runImport` resolves the workspace through the membership guard | `tenant-isolation.test.ts` |
| Steer an AI summary at a foreign record | Workspace derived from the record; retrieval scoped to it | `ai-boundary.test.ts` |
| Approve an AI proposal that links a foreign id | Every `matchId` re-validated against the target workspace | `ai-boundary.test.ts` |
| Probe for the existence of an id | Access failures return `not_found`, identical to a genuinely missing record | `adversarial.test.ts` |

**Residual risk.** Isolation is enforced in application code, not by database
row-level security. A raw query written outside the helpers, or a future
background job that forgets the filter, would bypass it. Mitigations in place:
`SCOPED_MODELS` and `assertRelations` cover every addressable model, and the
tests are per-entity rather than representative, so an action that forgets is
caught. Mitigation not in place: **PostgreSQL RLS as a second layer.**

### A3 / A4 — insider and privilege escalation

| Attack | Control | Proof |
|---|---|---|
| Viewer creates or edits | `record:create` / `record:edit` checked before the handler body | `adversarial.test.ts` |
| Member deletes permanently | `record:delete` not granted to members | `adversarial.test.ts` |
| Member exports the CRM | `record:export` not granted to members — reading one record is a different risk from walking out with all of them | `adversarial.test.ts` |
| Admin promotes themselves to owner | `canAssignRole` forbids granting at or above the granter's level | `permissions.test.ts` |
| Owner demotes the last owner, orphaning the workspace | Refused with a conflict | `adversarial.test.ts` |
| Escalate by sending `role` / `plan` / `ownerId` in a body | Not in any schema; Zod strips unknown keys; every write names its columns | `adversarial.test.ts` |
| Lift plan limits from the browser | No `changePlan` action exists; plan is webhook-only | `events.test.ts` |
| Delete the trail after acting | `AuditLog` has no update or delete path; entries outlive the workspace | `adversarial.test.ts`, `lifecycle.test.ts` |
| Bulk-extract via pagination | Page size ≤ 100, page ≤ 1000, export ≤ 50,000 rows, exports audited with counts | `validation.test.ts` |

**Residual risk.** A manager or admin can legitimately export everything. The
control is detection, not prevention: the export is audited with entity and row
count. **There is no alerting on that audit event** — see the scorecard.

### A5 — hostile content in the data

| Attack | Control | Proof |
|---|---|---|
| Stored XSS in a note | Allowlist sanitisation on write | `content-safety.test.ts` (21 payloads) |
| `javascript:` / `data:` URL in a website field | Scheme checked on the raw value before normalisation | `validation.test.ts` |
| CSV formula injection through a contact name | `=`, `+`, `-`, `@` neutralised on export | `content-safety.test.ts` |
| Prompt injection through a company name | Retrieved content is delimited, delimiter-stripped, and marked untrusted | `ai-boundary.test.ts` |
| Zip bomb / oversized CSV | 5,000 rows, 5 MB, bounded parser | `content-safety.test.ts` |
| Path traversal in a filename | Separators and control characters stripped | `content-safety.test.ts` |

**Residual risk — prompt injection.** Delimiters and instructions raise the cost;
they do not make injection impossible, and no known technique does. The reason
this is *contained* rather than merely mitigated is architectural: a successful
injection can influence what the model *says*, but not what it *reads* (scope is
resolved before generation) and not what it *writes* (it has no write
capability). The worst realistic outcome is a misleading summary shown to a user
who can already see the underlying records.

### A1 — anonymous internet

| Attack | Control | Proof |
|---|---|---|
| Credential stuffing | Per-account and per-address rate limits, 8-failure lockout, constant-time comparison | `auth.test.ts` |
| Account enumeration via sign-in or sign-up | Identical responses; identical timing | `auth.test.ts` |
| Reaching an unexported server helper | Server-only modules carry no `"use server"` | `SECURITY.md` §4 |
| Forging a billing webhook | HMAC-SHA256 over `timestamp.body`, constant-time, 300 s replay window, idempotent delivery | `events.test.ts` |
| Resource exhaustion via search or AI | Named rate-limit policies, bounded queries, capped context | `adversarial.test.ts` |
| 500-based information disclosure | All errors normalised; no stack, SQL or path reaches a client | `adversarial.test.ts` |

**Residual risk.** The default rate-limit store is in-memory and per-instance.
On a horizontally scaled deployment, an attacker gets N times the limit and it
resets on every deploy. **Redis is required before this is a real control.**

### A6 — supply chain

| Attack | Control |
|---|---|
| Malicious or vulnerable dependency | `npm audit` in CI; critical advisories in runtime dependencies fail the build; lockfile committed; `npm ci` everywhere |
| Committed secret | `.env*` git-ignored; secret scan over full history in CI |
| Build-time code execution | Not defended against beyond the above; no dependency pinning by integrity policy, no provenance verification |

**Residual risk.** Four high advisories are accepted, all transitive under the
Prisma CLI, none reachable from the deployed runtime (`docs/SECURITY.md` §14).

---

## 5. What an attacker gets from each compromise

| Compromise | Blast radius |
|---|---|
| One user's password | That user's workspaces only. Mitigated by lockout and rate limits; **not** mitigated by MFA, which does not exist |
| One session cookie | Same, for up to 14 days. `HttpOnly` blocks XSS theft; there is **no session revocation list**, so a stolen JWT is valid until it expires or the account is deactivated |
| `AUTH_SECRET` | Total. Any session for any user can be minted. The production gate refuses a weak or published secret; rotation is a manual operation |
| Database credentials | Every tenant. No encryption at rest beyond what the host provides; no field-level encryption |
| AI provider key | Billing abuse and access to prompts sent while it was valid |
| Application server | Everything |

---

## 6. Assumptions

The model assumes, and does not verify:

1. TLS terminates in front of the app and HTTP is redirected to HTTPS. The
   production gate refuses a non-HTTPS `APP_URL`, but cannot enforce the
   listener.
2. The database is not reachable from the public internet.
3. `AUTH_SECRET` and provider keys come from a secrets manager, not from a file
   in the repository.
4. Backups exist and have been restored at least once as a drill. Tiny CRM
   provides no backup mechanism of its own — see `docs/DEPLOYMENT-CHECKLIST.md`.
5. The host provides encryption at rest.
6. Operators of the deployment are trusted.

---

## 7. Data leaving the deployment

Two paths, both worth stating explicitly to whoever signs off on this product
holding client data:

1. **The AI provider.** When `AI_PROVIDER` is Anthropic or OpenAI, a bounded
   slice of CRM context — record names, companies, deal values, recent activity,
   note text — is sent to that provider on every summary, brief and question.
   Setting `AI_PROVIDER=offline` uses the built-in deterministic engine and sends
   nothing. There is no per-workspace opt-out, and no data-processing agreement
   is asserted or verified by the application.
2. **Nothing else.** There is no product analytics, no error-reporting service,
   no third-party script, and no outbound telemetry. `next.config.ts` restricts
   remote images to a narrow allowlist. Observability integration points exist
   but are unconfigured.

---

## 8. Explicitly out of scope

Not defended against, by decision:

- A malicious hosting provider, database host or AI provider.
- A compromised developer machine or CI runner.
- Physical access to infrastructure.
- Denial of service at the network layer (belongs to the CDN/WAF).
- A malicious workspace owner acting within their own workspace — an owner can
  delete their own data, and that is the intended behaviour.
- Traffic analysis and timing side channels beyond the authentication paths.

---

## 9. The gaps that would change this document

In rough order of how much they would improve the model:

1. **Redis-backed rate limiting** — turns a per-instance nuisance into a control.
2. **MFA and session revocation** — currently a stolen cookie is good for 14 days.
3. **PostgreSQL row-level security** — a second, database-enforced layer under
   application-enforced tenancy.
4. **Email verification and password reset** — the models exist, the flows do not.
5. **Alerting on audit events** — bulk export, role change, workspace deletion.
6. **A malware scanner** — `src/lib/uploads.ts` enforces an extension
   allowlist, checks magic bytes against the declared type, generates its own
   storage keys and forces `Content-Disposition: attachment`, and it is covered
   by tests. What it does not have is a scanner: `scanForMalware()` is a seam
   that logs its own absence, and fails closed when `REQUIRE_MALWARE_SCAN` is
   set. Uploads are disabled in this build (`files` flag off,
   `STORAGE_DRIVER=none`); wire a scanner before enabling them.
7. **A verified backup restore** — see the scorecard.
