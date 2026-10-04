# Data Processing Addendum — DRAFT FOR LEGAL REVIEW

> **This is not a DPA. It is raw material for one.**
>
> The factual annexes (B, C, D) are written from the implementation and are
> accurate — subprocessors verified from headers and configuration, security
> measures verified from code, data categories verified from the schema. Those are
> the parts a lawyer cannot write without reading the codebase.
>
> The operative clauses — liability, indemnities, audit rights, deletion
> obligations, transfer mechanism — are marked **[COUNSEL]** and deliberately left
> unwritten. They create binding obligations and real financial exposure, and
> drafting them from a template is how a company promises something its software
> does not do. Section 7 is the clearest example: the obvious wording would commit
> to deletion on termination, and there is currently **no account-closure path in
> the product at all**.
>
> Do not offer this to a customer, and do not state that "a DPA is available",
> until counsel has replaced every **[COUNSEL]** marker.

Controller: the customer. Processor: **Artifact Digital LLC**, 178 N. Cuyamaca St.,
El Cajon, CA 92020, United States.

---

## 1. Scope and roles

**[COUNSEL]** — The controller/processor split needs confirming before this clause
can be written. The working reading, from how the product behaves:

- The customer is the **controller** of the personal data they enter about their
  own contacts. They choose what to store and why; Tiny CRM has no relationship
  with those people and never contacts them.
- Artifact Digital LLC is the **processor** of that data.
- Artifact Digital LLC is the **controller** of the customer's own account data —
  name, email, password hash, sessions, billing status — because it decides to
  collect those in order to run the service.

That split determines which clauses this document needs at all, so it is the first
question for counsel rather than a detail.

## 2. Subject matter and duration

**[COUNSEL]** — Normally tied to the subscription term, which raises the deletion
question in section 7.

## 3. Processing instructions

The processor processes personal data only to provide the service, and on the
controller's documented instructions. Using customer content to train any
machine-learning model is excluded, and that exclusion is factual rather than
aspirational: no training pipeline exists, and model requests are per-request
inference only.

**[COUNSEL]** — the clause permitting processing required by law, and the duty to
notify when an instruction appears unlawful.

## 4. Confidentiality

**[COUNSEL]**

## 5. Security

See **Annex C**, which describes measures that are implemented and verifiable.

**[COUNSEL]** — the obligation wording around them, and whether any measure is
being warranted rather than merely described.

## 6. Subprocessors

See **Annex B**. **[COUNSEL]** — notice period for changes, and the objection right.

## 7. Deletion and return of data

**[COUNSEL] — and read the warning first.**

The obvious clause ("on termination the processor deletes all personal data within
N days") **cannot be honoured by the current implementation**:

- There is **no account-closure path**. No `user.delete`, no delete-account
  action, no route. An account cannot presently be closed through the product.
- **Trash is never purged.** `TRASH_RETENTION_DAYS = 30` is declared in
  `src/lib/workspaces/policy.ts` and referenced nowhere else. Archived records
  stay indefinitely.
- **Audit records are never purged.** `auditLog.delete` appears nowhere in the
  codebase, and the retention sweep does not touch that table. The application's
  database role is deliberately denied `UPDATE` and `DELETE` on it.
- **Point-in-time recovery is 6 hours** — Neon free-plan history retention,
  confirmed in the console. That is a *recovery* window and not a deletion
  guarantee: it does not establish that a deleted record is gone from the
  provider's storage layers after six hours, and no clause should imply it does.
  Note also that no independent copy exists: Neon branching is copy-on-write
  within the same project, so it recovers from an application mistake and not
  from account loss or a provider failure (docs/NEON-RECOVERY-DRILL.md).

What **is** implemented and can be promised:

- **Workspace deletion** is scheduled with a **7-day** grace period
  (`WORKSPACE_DELETION_GRACE_DAYS`), during which the workspace is read-only and
  the deletion can be cancelled. A job handler then performs it, and it cascades
  to the workspace's records.
- **Export** is available to the controller at any time, without asking, as CSV.
- **Operational data** is purged on a daily sweep (Annex D).

Any deletion commitment beyond that needs the gap closed first. See section 9.

## 8. Transfers

**[COUNSEL]** — Whether a transfer mechanism is required depends on where the
controller and the data subjects are. Annex B gives the locations that are known;
two are not confirmed and are marked as such.

## 9. Known gaps — close before offering this

Each is a prerequisite, not a caveat:

1. **Build account closure.** It does not exist. It must also handle the shared
   case: `Workspace.owner` is declared `onDelete: Cascade`, so deleting an owner
   would destroy every workspace they own — including workspaces other people are
   members of, taking their data with it. Closure needs to either transfer
   ownership or refuse while other members remain. Promising deletion before this
   is built would be promising a cascade nobody intends.
2. **Enforce trash retention**, or describe trash accurately as indefinite.
3. **Decide audit retention.** Indefinite is defensible for a security log, but it
   must be stated rather than implied away by a general deletion clause.
4. **Decide whether 6 hours of recovery is acceptable to contract on.** The window
   is now known rather than unread, and it is short: a deletion noticed after six
   hours is unrecoverable at the database level, and there is no independent copy
   at all. What the provider keeps beyond that window is still unestablished, so a
   deletion clause must not be worded as if the window were an erasure period.
5. ~~**Confirm Resend's processing region**~~ — resolved from Resend's own
   documentation: account data, email metadata, logs and API records are stored
   in the **United States** whatever sending region is selected.
6. **Compare the deployed database endpoint with the production branch.** The
   region is settled, but an endpoint id does not name its branch, and the
   plan/usage audit used a direct (non-pooled) host while the application most
   likely uses the pooled one. Until the host in Vercel's production
   `DATABASE_URL` is compared with the production branch's endpoint host in Neon,
   nothing should be inferred about which branch any earlier audit read.

---

# Annex A — Data categories and subjects

| Subjects | Personal data |
|---|---|
| The controller's contacts (data subjects with no relationship to us) | Name, job title, email, phone, website, social handle, location, free-text notes, relationship and lifecycle fields, custom fields, uploaded file contents |
| The controller's own users | Name, email, password hash, time zone, optional job title and avatar, sessions with a truncated IP and device description, second-factor credentials |
| Billing contact | Name, email, Stripe customer identifier, plan, plan status, renewal or end date. **No card data** — cards are entered on Stripe's pages and never reach this service |

Special-category data is not solicited and no field is designated for it. A
free-text note can contain anything the controller types, which is inherent to a
CRM. **[COUNSEL]** — whether that needs addressing explicitly.

# Annex B — Subprocessors

| Subprocessor | Purpose | Location | Basis |
|---|---|---|---|
| Vercel | Application hosting | US West (Oregon) | Verified: `vercel.json` pins `regions: ["pdx1"]` |
| Neon | PostgreSQL database | AWS `us-west-2`, US West (Oregon) | Region confirmed from the Neon console (a project has one region, so every branch is in it). **Which branch the deployed app uses is not yet confirmed** — see gap 6 |
| Cloudflare R2 | Uploaded file storage, bucket `tiny-crm-documents` | Western North America (WNAM) | Cloudflare's own label. R2 hints name a broad area, not a country |
| Resend | Transactional email only | **Not confirmed** | Verified from message headers: DKIM `s=resend` on `d=tinycrm.biz`, Message-ID domain `rsend.tinycrm.biz` |
| Amazon SES | Email delivery beneath Resend | **Not confirmed** | Resend's own subprocessor, not contracted with directly. Observed sending host `smtp-out.amazonses.com` |
| Anthropic | Model inference, only for workspaces with AI enabled | **Not pinned to a region** — `inference_geo` is set nowhere, so default global routing applies | Verified from code |
| Stripe | Payment processing | Per Stripe's terms | Not yet live |

Transactional email carries a name, an email address and a link — never CRM record
contents. Telemetry carries an allowlist of fields and never record contents, note
text, prompts, passwords or tokens.

# Annex C — Technical and organisational measures

Each is implemented and locatable in the codebase.

- **Tenant isolation enforced by the database**, not only by application code.
  Every tenant table is `ENABLE` + `FORCE ROW LEVEL SECURITY`; a query arriving
  without a workspace context returns nothing rather than everything, because
  `x = ANY(NULL)` is null. Forced, so the table owner is subject to it too.
- **Record-level access** for restricted members, enforced by policy rather than
  by filtering in application code.
- **Passwords** hashed with bcrypt; never stored or logged in readable form.
- **Optional two-factor authentication** with recovery codes.
- **Session revocation**, individually or globally, with a session epoch that
  invalidates every existing token at once; a password change invalidates sessions
  minted before it.
- **Append-only audit log** — the application's database role is denied `UPDATE`
  and `DELETE` on that table.
- **Brute-force protection**: failed-attempt counting and lockout.
- **Rate limiting** across authentication, mutation, AI and webhook surfaces.
- **Signed, timestamped, idempotent webhooks**: HMAC verified in constant time, a
  replay window, and a claimed event id so a redelivery applies once.
- **No secret in the browser bundle** — asserted by a test that fails if a
  server-only variable name appears in client code.
- **AI transmission controlled per workspace**, with a mode that fails closed and a
  bounded prompt budget; disabled workspaces transmit nothing and keep every
  deterministic feature.
- **Encryption in transit** throughout; at rest by the hosting and storage
  providers.

**Not claimed:** no SOC 2, no ISO 27001, no HIPAA, no penetration-test report, no
zero-retention guarantee from any model provider, no uptime commitment.

# Annex D — Retention, as implemented

**Purged automatically, on a daily sweep** (cron `17 4 * * *`; 468 cron
invocations observed in a 48-hour production window):

| Data | When |
|---|---|
| Expired sessions | On sweep |
| Used or expired auth tokens | On sweep |
| Completed domain events | 30 days after processing |
| Expired idempotency keys | On expiry |
| Acknowledged security alerts | 365 days |
| Rate-limit counters | On sweep |

**Not purged automatically:**

| Data | Actual behaviour |
|---|---|
| Records in Trash | Kept indefinitely. The 30-day constant exists but is enforced nowhere |
| Audit log | Kept indefinitely; never deleted by any code path |
| Customer business records | Kept until the controller deletes them |
| Deleted workspaces | Executed after a 7-day grace period, cancellable during it |
| Point-in-time recovery | **6 hours** (Neon free-plan history retention, confirmed in the console). A recovery window, not an erasure period. No independent copy exists |
