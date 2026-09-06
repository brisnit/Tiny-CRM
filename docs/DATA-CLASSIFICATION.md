# Data classification

What Tiny CRM stores, how sensitive each kind is, and what that implies for
storage, logging, AI, export and retention.

This exists so those decisions are made once, in the open, rather than
re-litigated per feature. Where the application already enforces a rule, the file
that does it is named. Where it does not, the row says so.

---

## The classes

| Class | Meaning | If it leaked |
|---|---|---|
| **PUBLIC** | Intended to be seen by anyone | Nothing |
| **INTERNAL** | Operational; not secret, not for customers | Reveals how the system works; useful to an attacker as reconnaissance |
| **CONFIDENTIAL** | A customer's business information | Competitive harm to the customer, and a breach of the trust the product is sold on |
| **HIGHLY SENSITIVE** | Personal data, or a credential | Harm to a person, or takeover of an account |

The critical distinction for this product is that **almost everything a user
types is CONFIDENTIAL and belongs to somebody other than the user**. A CRM is a
store of other people's information: their clients' names, their pipeline, their
candid assessments. That is the standard the rest of this file applies.

---

## Classification

### HIGHLY SENSITIVE

| Data | Where | Notes |
|---|---|---|
| Passwords | `User.passwordHash` | Never stored in plaintext. bcrypt cost 12, `src/lib/auth/password.ts`. |
| Session identifiers | `UserSession.tokenHash` | SHA-256 only. A database copy yields no usable session. |
| Reset & verification tokens | `AuthToken.tokenHash` | SHA-256 only; 32 bytes of entropy, so no salt is needed. |
| TOTP secrets | `MfaCredential.secretEncrypted` | AES-256-GCM, key derived from `AUTH_SECRET`. Must be reversible — the server reproduces the code. |
| Recovery codes | `MfaRecoveryCode.codeHash` | bcrypt. Shown once, never again. |
| Provider API keys | Environment only | Never in the database, never in a log, never in an error report. |
| `AUTH_SECRET` | Environment only | Compromise is total: any session for any user can be minted. |
| Contact PII | `Contact.email`, `.phone`, `.linkedin`, `.location`, `.fullName` | Not the user's own data — their clients'. Directly usable to phish the customer's customers. |
| Attendee addresses | `EventAttendee`, `EmailMessage` | Third-party personal data arriving through integrations. |

### CONFIDENTIAL

| Data | Where | Notes |
|---|---|---|
| Note bodies | `Note.body`, `.plainText` | In practice the most sensitive store in the product: candid assessments of clients and staff, pricing floors, personal detail. Sanitised on write; never logged. |
| Deal values and stages | `Deal.valueCents`, `.stageId`, `.probability` | Revenue and pipeline. Useful to a competitor and to anyone pricing against the customer. |
| RFP / opportunity records | `Opportunity.*` | Solicitation numbers, deadlines, requirements, bid strategy — timed leverage in a live competitive process. |
| Company records | `Company.*` | Who the customer works with. |
| Project detail | `Project.*`, `Milestone.*` | Budgets, revenue, delivery risk. |
| Files | `FileAsset` + object storage | Proposals and contracts. **Uploads are disabled in this build.** |
| Activity timeline | `Activity.*` | What was said, to whom, when. |
| Email and calendar | `EmailMessage`, `CalendarEvent` | Third-party correspondence. |
| AI summaries | `AiInsight.body` | Compressed versions of everything above — and easier to exfiltrate than the source, because one record carries the gist of many. |
| AI conversations | `AiThread`, `AiMessage` | Questions reveal what the user is worried about; answers quote the records. |
| Custom field values | `CustomFieldValue.value` | Unknowable in advance. Treated at the highest class its container implies. |

### INTERNAL

| Data | Where | Notes |
|---|---|---|
| Audit log | `AuditLog` | Who did what. Summaries name records, so it is not PUBLIC — but its integrity matters more than its secrecy. |
| Security alerts | `SecurityAlert` | Same. |
| Job queue and runs | `DomainEvent`, `JobRun` | Payloads carry record names. |
| Sessions metadata | `UserSession.ipPrefix`, `.deviceLabel` | Truncated to a /24 or /48 on purpose — a session list should say "somewhere else", not keep a movement history. |
| Rate-limit counters | `RateLimitCounter` | Keys are **keyed digests**, so this never becomes a second list of who uses the product and from where. |
| Feature flags | `FeatureFlag` | Configuration. |
| Plan and usage | `User.plan`, `UsageCounter` | Commercially interesting, not confidential. |
| Structured logs | Log destination | Redacted (`src/lib/logger.ts`), but still reveals shape and volume. |

### PUBLIC

| Data | Where |
|---|---|
| Marketing pages, pricing | `src/app/(marketing)` |
| Enum labels, pipeline stage defaults, plan limits | `src/lib/enums.ts`, `src/lib/plans.ts` |
| The application's own source | This repository |

---

## Rules per class

### Storage

| Class | Rule | Enforced by |
|---|---|---|
| HIGHLY SENSITIVE (credentials) | Hashed if only verified; encrypted if it must be reproduced. Never plaintext. | `auth/password.ts`, `auth/tokens.ts`, `auth/sessions.ts`, `auth/mfa.ts` |
| HIGHLY SENSITIVE (PII) & CONFIDENTIAL | Workspace-scoped, isolated at two layers | `auth/access.ts`, `prisma/postgres/002_row_level_security.sql` |
| INTERNAL | Same tenancy rules; `AuditLog` additionally append-only | `REVOKE UPDATE, DELETE ON "AuditLog"` |
| All | Encryption at rest is the **host's** responsibility. Tiny CRM adds no field-level encryption beyond TOTP secrets. | — |

### Logging

**Never logged, in any class:** passwords, session tokens, reset tokens, API
keys, card data, note or document contents, raw AI prompts.

`redact()` in `src/lib/logger.ts` strips values by key name
(`pass(word|hash)?|secret|token|api[-_]?key|authorization|cookie|session|credential|ssn|card`)
and by value shape, before anything is written, and the same function runs over
audit metadata and security-alert metadata. Strings are truncated at 2,000
characters and traversal is depth-limited.

Error reports are built from an explicit allowlist rather than by an SDK's
automatic instrumentation — type, message, stack, request id, route, user and
workspace **ids**. Messages are scrubbed of quoted rows and email addresses;
stacks are stripped of filesystem paths (`src/lib/observability.ts`).

A test asserts the redaction works and that non-sensitive values survive it —
over-redaction makes logs useless, which leads to logging being turned off.

### AI eligibility

| Class | May be sent to a model provider |
|---|---|
| PUBLIC | Yes |
| INTERNAL | No. Nothing operational is included in AI context. |
| CONFIDENTIAL | **Only when the workspace's AI mode permits it** |
| HIGHLY SENSITIVE — credentials | **Never**, in any mode |
| HIGHLY SENSITIVE — contact PII | Names and job titles yes; email and phone are included only on the record being summarised |

Decided **per workspace**, not per account (`src/lib/ai/privacy.ts`): one person
may run their own business and a client's in the same account, under different
obligations.

- `disabled` — nothing leaves. Scoring, momentum, stall detection, the cleanup
  scan and the daily brief keep working; they never needed a model.
- `enabled` — a bounded slice (14,000 characters) may be sent to the configured
  provider.
- `private` — fails closed until an operator asserts an enterprise agreement.

A mixed scope keeps the whole answer local: one workspace with AI off is enough.
The settings screen names the provider and the model, and lists what is sent and
what never is.

### Export

| Class | Rule |
|---|---|
| CONFIDENTIAL & PII | Requires `record:export` (not granted to members), a **verified email address**, one workspace per file, rate-limited per user *and* per workspace, and audited with a row count |
| Credentials | Never exportable by any path |
| Audit log | Readable with `audit:view`; not part of the CSV export surface |

Every exported cell is passed through `neutralizeCsvCell`, so a stored value
beginning `=`, `+`, `-` or `@` cannot execute when the file is opened.

An export is the shape an exfiltration takes. The control is detection as much as
prevention: `data.exported` is audited with the entity and row count, and raises
a `data.mass_export` alert.

### Retention

**Stated as intent, not as an implemented policy.** Automated purging does not
exist; what follows is what the schema supports and what should be configured.

| Data | Current behaviour | Intended |
|---|---|---|
| Archived records | Kept indefinitely; visible in Trash; excluded from lists, search, AI context and export | Purge after 30 days (`TRASH_RETENTION_DAYS`) — **not yet automated** |
| Deleted records | Removed; related rows detached, not destroyed | As is |
| Deleted workspace | 7-day grace period, then full cascade | As is |
| `AuditLog` | Kept indefinitely, including after the workspace is deleted | 2 years, then purge — **not implemented** |
| `DomainEvent` | Completed events swept after 30 days by the worker | As is |
| `JobRun` | Kept indefinitely | Purge with its event — **not implemented** |
| `UserSession` | Expired rows swept after 30 days | As is |
| `AuthToken` | Swept after 30 days | As is |
| `RateLimitCounter` | Swept when expired | As is |
| `SecurityAlert` | Kept indefinitely | 1 year, then purge — **not implemented** |
| `AiInsight` | Kept indefinitely | Purge with the record — **not implemented** |
| Structured logs | Whatever the destination is set to | 30–90 days |

**No compliance claim is made anywhere.** Tiny CRM has not been audited or
assessed against SOC 2, ISO 27001, GDPR or any other framework, and this document
does not assert that it satisfies one. A customer subject to such obligations
should read this file as a description of behaviour, not as a control mapping.

---

## Data leaving the deployment

Two paths, and only two:

1. **The AI provider**, when a workspace's mode permits it. Governed above.
2. **The configured observability sink and alert webhook**, carrying the
   allowlisted fields described in *Logging* — never CRM content.

There is no product analytics, no third-party script, no session recorder and no
outbound telemetry. `next.config.ts` restricts remote images to two named hosts,
and `connect-src 'self'` means the browser cannot reach any other origin.

---

## Where a new field goes

1. Would the customer mind a competitor reading it? → **CONFIDENTIAL**.
2. Does it identify a person who is not the user? → **HIGHLY SENSITIVE**.
3. Does it grant access to anything? → **HIGHLY SENSITIVE**, and hashed or
   encrypted.
4. Is it about the system rather than the customer? → **INTERNAL**.
5. Otherwise → **PUBLIC**, and be sure.

Free-text fields default to CONFIDENTIAL, because a user will eventually put
something confidential in one. `Contact.description`, `Deal.nextStep` and every
custom field are classified that way for exactly this reason.
