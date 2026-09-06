# Data retention

What Tiny CRM keeps, for how long, and which of those rules are actually
enforced by code today.

The distinction that governs this whole document: **operational data is purged
on a timer; customer business data is not.** A cleanup job that deletes a
customer's contacts because a counter expired is indistinguishable from data
loss. Anything a customer typed is removed only when they ask, or under a
published policy they have agreed to.

Status column meanings:

- **ENFORCED** — code does this today, on the sweep run by `/api/cron/jobs?sweep=1`
  (or `npm run worker`). Named function given.
- **PROPOSED** — a recommended default, deliberately not implemented. Turning it
  on is a product decision that needs a user-facing policy first.

---

## Operational data — purged automatically

These are records about the system, not about the customer's business. Class
INTERNAL in `docs/DATA-CLASSIFICATION.md`.

| Data | Retention | Status | Where |
|---|---|---|---|
| Expired sessions (`UserSession`) | 30 days after expiry | **ENFORCED** | `pruneSessions()` |
| Spent/expired auth tokens (`AuthToken`) | 30 days | **ENFORCED** | `pruneTokens()` |
| Completed jobs (`DomainEvent` status `done`) | 30 days after processing | **ENFORCED** | `sweep()` |
| Job attempt records (`JobRun`) | with their event | **ENFORCED** | FK cascade |
| Idempotency keys | at expiry | **ENFORCED** | `sweep()` |
| Rate-limit counters | at window expiry | **ENFORCED** | `PostgresStore.sweep()` |
| Acknowledged security alerts | 365 days | **ENFORCED** | `sweep()` |
| **Un**acknowledged security alerts | kept indefinitely | by design | — |

An unacknowledged alert is unfinished work. It is never aged out.

---

## Customer business data — not purged automatically

Class CONFIDENTIAL or HIGHLY SENSITIVE. **Nothing below is deleted on a timer.**

| Data | Current behaviour | Recommended default | Status |
|---|---|---|---|
| Active records (contacts, companies, deals, projects, opportunities, tasks, notes) | Kept until deleted | Kept for the life of the account | — |
| Archived records (Trash) | Kept indefinitely; hidden from lists, search, AI context and export | Purge 30 days after archiving (`TRASH_RETENTION_DAYS`) | **PROPOSED** |
| Deleted records | Removed immediately; related rows detached, not destroyed | As is | — |
| Deleted workspace | 7-day grace period, then full cascade (`WORKSPACE_DELETION_GRACE_DAYS`) | As is | **ENFORCED** |
| Uploaded files | Uploads are disabled in this build | Purge with the record; separate object-store lifecycle rule | **PROPOSED** |
| AI insights (`AiInsight`) | Kept indefinitely | Purge with the record they describe | **PROPOSED** |
| AI threads and messages | Kept until the workspace is deleted | 12 months | **PROPOSED** |
| Exports | Generated and streamed; never stored server-side | As is — nothing to retain | — |

### Why Trash purge is proposed rather than enforced

It is the single most defensible automatic deletion in the list, and still not
implemented, because archiving is currently presented to the user as
*recoverable* with no stated deadline. Adding a 30-day timer would silently
convert an existing promise into a different one. Enable it only alongside:

1. a stated retention period in the Trash screen itself,
2. a stated period in the privacy notice, and
3. a warning before the deadline for anything about to be purged.

Until those exist, indefinite retention is the honest behaviour.

---

## Audit and security records

| Data | Current behaviour | Recommended default | Status |
|---|---|---|---|
| `AuditLog` | Kept indefinitely, including after workspace deletion | 2 years | **PROPOSED** |
| Structured logs | Whatever the destination retains | 30–90 days | host-configured |
| Error reports (Sentry or equivalent) | Provider default | 90 days | provider-configured |

`AuditLog` is deliberately append-only — `UPDATE` and `DELETE` are revoked from
the runtime role at the database level, so the application *cannot* purge it
even if asked. Any retention rule for it must run as the migration/admin role,
as a deliberate, logged maintenance action. That is a feature: an audit trail an
application can trim on a schedule is not much of an audit trail.

Audit rows survive workspace deletion on purpose. They record *who deleted the
workspace*, which is exactly the event you would want evidence of afterwards.

---

## Recommended defaults for a small-business SaaS

If you adopt these, publish them in the privacy notice **before** enabling any
of them:

| Category | Recommended |
|---|---|
| Active customer records | Life of the account |
| Archived / Trash | 30 days, with in-app warning |
| Account closure → full erasure | 30-day grace, then cascade |
| Audit log | 2 years |
| Security alerts | 1 year after acknowledgement |
| Sessions & tokens | 30 days past expiry |
| Operational logs | 90 days |
| Backups | 7–30 days of point-in-time recovery |

**Backups are the exception nobody expects.** Deleting a record from the live
database does not remove it from backups taken before the deletion. It ages out
of them at the backup retention period. Any erasure commitment made to a
customer must be worded to account for that, or it is not accurate.

---

## What is deliberately not done

- **No automatic deletion of customer business data.** Not archived records, not
  the audit log, not AI insights.
- **No compliance claim.** Tiny CRM has not been assessed against SOC 2,
  ISO 27001, GDPR, CCPA or any other framework. This file describes behaviour;
  it is not a control mapping, and adopting the table above does not constitute
  compliance with anything.
- **No erasure-request workflow.** Deleting a workspace cascades its data, which
  is the closest existing mechanism. A per-person erasure request across
  workspaces is not implemented.
