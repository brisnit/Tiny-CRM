# Privacy notice — DRAFT

> **This is a draft, not a published legal document.** It was written to
> describe what the software actually does, so that a lawyer has something
> accurate to work from. Sections marked **[LEGAL REVIEW]** need professional
> input before this is shown to anyone outside the team. Do not publish it as-is.

Last updated: 2026-09-06 · Applies to: Tiny CRM, self-hosted or operated by the
account owner.

---

## 1. What this service is

Tiny CRM is a customer-relationship tool. You use it to store information about
**your** clients, deals, projects and notes. Most of what it holds was typed by
you and is about somebody else — a third party who is not a user of this service
and has no direct relationship with it. That shapes everything below.

**[LEGAL REVIEW]** — In data-protection terms this makes the operator a
processor for customer-entered contact data and a controller for account data.
That split needs confirming, and determines what else this notice must contain.

---

## 2. What is collected

### Information you provide

| Category | Examples |
|---|---|
| Account | Email address, name, job title, password (stored only as a bcrypt hash) |
| CRM content | Contacts, companies, deals, projects, opportunities, tasks, notes, tags, custom fields |
| Third-party personal data | Names, email addresses, phone numbers, locations and LinkedIn URLs of people you record as contacts |
| Files | Proposals and documents — **uploads are disabled in this build** |

### Information generated automatically

| Category | Detail |
|---|---|
| Sessions | A hashed session identifier, the time, a **truncated** IP address (to a /24 or /48 — enough to say "somewhere else", not to track movement), and a coarse device label |
| Audit log | Who did what, and to which record |
| Security alerts | Repeated failed sign-ins, unusual exports, configuration failures |
| Operational logs | Request timing and errors, with values redacted by key name and shape |
| Rate-limit counters | Stored as **keyed hashes**, never as raw email addresses or IPs |

### Not collected

No advertising identifiers. No third-party analytics. No session recording. No
tracking pixels. No cross-site tracking. The browser is prevented from
contacting any origin other than this application's own by a Content Security
Policy.

---

## 3. Cookies

One cookie: the session cookie, required to stay signed in. It is
`HttpOnly`, `Secure` and `SameSite`. There are no advertising or analytics
cookies, so there is nothing to consent to beyond signing in.

**[LEGAL REVIEW]** — Whether a cookie banner is required in your jurisdiction
given a strictly-necessary-only cookie set.

---

## 4. How information is used

- To provide the service: storing and showing your records.
- To keep the account secure: authentication, session management, rate limiting,
  audit logging, security alerting.
- To operate the system: error diagnosis and performance work.

It is **not** used to build advertising profiles, sold, or shared with data
brokers. It is not used to train any machine-learning model — see §6.

---

## 5. Where data goes

Only two categories of data ever leave this deployment:

1. **The AI provider**, and only when the workspace's AI mode permits it (§6).
2. **Operational telemetry** — error reports and logs sent to the configured
   monitoring provider. These carry an explicit allowlist of fields: error type,
   message, stack trace, request identifier, route, and user/workspace
   **identifiers**. Messages are stripped of quoted database values and email
   addresses; stack traces are stripped of file paths. **CRM record contents, note
   text, email bodies, AI prompts, passwords and tokens are never included.**

Subprocessors depend on how the operator configured the deployment: a hosting
provider, a database provider, an email delivery provider, an error-monitoring
provider, and an AI provider if enabled.

**[LEGAL REVIEW]** — A published subprocessor list with names and locations, and
whether international transfer terms are required.

---

## 6. Artificial intelligence

**AI is controlled per workspace, not per account** — one person may run their
own business and a client's in the same account under different obligations.

| Mode | Behaviour |
|---|---|
| **Disabled** | **Nothing leaves.** Relationship scoring, deal momentum, stall detection, project health, go/no-go calls, the hygiene scan and the daily brief all keep working — they are computed by the application and never needed a model. |
| **Enabled** | A bounded slice of workspace content (up to ~14,000 characters) may be sent to the configured provider to generate prose and answer questions. |
| **Private** | Fails closed until an operator asserts an enterprise agreement. |

When a request spans several workspaces and any one of them has AI disabled, the
whole answer is produced locally.

**Never sent to a model provider, in any mode:** passwords, session tokens, API
keys, and any credential. Contact email addresses and phone numbers are included
only for the specific record being summarised.

The settings screen names the provider and model in use and lists what is sent
and what never is.

**No claim is made that any AI provider performs zero retention.** Whether your
prompts are retained, and for how long, is determined by the operator's contract
with that provider. If that matters to you, use AI Disabled — the deterministic
features are unaffected.

---

## 7. Security

- Passwords are hashed with bcrypt (cost 12) and never stored in plaintext.
- Session identifiers and reset tokens are stored only as SHA-256 hashes, so a
  copy of the database yields no usable session.
- Two-factor secrets are encrypted at rest (AES-256-GCM).
- Every workspace is isolated at two independent layers: the application's own
  access checks, **and** PostgreSQL row-level security, so a query that omitted
  the application filter still could not return another tenant's rows.
- The audit log is append-only, enforced by the database rather than by
  convention.

**[LEGAL REVIEW]** — Breach-notification timelines and obligations.

No representation is made that the service is invulnerable.

---

## 8. Retention

Summarised from `docs/RETENTION.md`:

- **Your CRM records are kept until you delete them.** Nothing is purged on a
  timer.
- Archived records stay in Trash and are recoverable.
- Deleting a workspace begins a **7-day grace period**, after which its data is
  permanently removed.
- Sessions and authentication tokens are cleared 30 days after expiry.
- The audit log is retained indefinitely at present, including after a workspace
  is deleted, because it records who performed the deletion.

**Backups.** Deleting something removes it from the live database, but not from
backups already taken. It ages out as those backups expire.

---

## 9. Your choices

- **Export.** CRM data can be exported to CSV at any time. Export requires a
  verified email address and is audited.
- **Correction.** Records are editable in the application.
- **Deletion.** Individual records can be deleted; a whole workspace can be
  deleted with a 7-day grace period.
- **AI.** Disable it per workspace at any time without losing deterministic
  features.

**[LEGAL REVIEW]** — Whether statutory rights (access, portability, erasure,
objection, restriction) apply, and the mechanism and deadlines for responding.
A per-person erasure workflow spanning workspaces is **not implemented today**.

---

## 10. What is explicitly NOT claimed

Stated plainly because these claims are commonly made without basis:

- **Not** SOC 2 certified, audited, or in an active assessment.
- **Not** assessed against ISO 27001.
- **No** GDPR, UK GDPR, CCPA/CPRA, HIPAA or PCI-DSS compliance claim. No DPA,
  BAA or SCCs are offered at this stage.
- **No** claim of zero retention by any AI provider.
- **No** claim that the service is suitable for special-category, health,
  financial-account or payment-card data. Do not put such data in it.
- **No** penetration test by an independent third party has been performed.

The service is currently operated for **owner testing**, not as a
generally-available product.

---

## 11. Children

Not directed at children and not intended for anyone under 16.

## 12. Changes

Material changes will be announced in-app before taking effect.

## 13. Contact

**[LEGAL REVIEW]** — Operator's legal entity name, postal address, contact
address for privacy requests, and a representative if one is required.
