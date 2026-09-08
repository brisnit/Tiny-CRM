# Beta data retention and privacy plan

**Status: proposal. Nothing here is implemented.** No automated deletion runs
today beyond the four ephemeral stores listed below. This document exists so a
beta customer asking "what happens to my data" gets an answer, and so the
answer is decided deliberately rather than by whatever the code happens to do.

The classification this builds on is `docs/DATA-CLASSIFICATION.md`.

## What is retained today, honestly

| Store | Automated purge today | Proposed beta policy |
|---|---|---|
| Sessions | yes — expiry sweep | unchanged |
| Auth tokens (verify / reset) | yes — expiry sweep | unchanged |
| Completed jobs | yes — retention sweep | unchanged |
| Rate-limit counters | yes — expiry sweep | unchanged |
| **Account (User)** | **no** | delete on request within 30 days; see below |
| **CRM records (archived / "trash")** | **no** | purge 30 days after archival |
| **Deleted workspace** | 7-day grace, then cascade | unchanged — this one is already right |
| **Audit log** | **no** | retain 12 months, then purge; survives workspace deletion by design |
| **Security alerts** | **no** | retain 12 months |
| **Uploaded files** | n/a — uploads are disabled (`STORAGE_DRIVER=none`) | policy needed *before* uploads are enabled |
| **Application logs (Vercel)** | provider default | provider default; contains request paths, not CRM content |
| **Error reports (Sentry)** | provider default (90 days) | 90 days; payload is an allowlist — see `docs/SECURITY.md` |
| **Database history (Neon)** | **6 hours** | raise to 7 days minimum — see below |

## Account deletion

A customer asking for deletion should get: their workspaces' CRM records
removed on the existing 7-day grace cascade, their `User` row removed, and
their audit entries **retained but de-identified** — `actorId` already nulls to
`SET NULL`, and `actorEmail` would need clearing.

The audit trail deliberately outlives the records it describes. That is a
security property worth keeping, and it is also a privacy claim that has to be
stated rather than discovered: *we keep a record that an action happened, and
who did it, after the record itself is gone.*

## AI provider exposure

Per-workspace, not per-account. `disabled` sends nothing and every
deterministic feature keeps working; `private` fails closed. What must not be
claimed: zero retention. That is a contract term, not a property of a vendor's
API, and **no data-processing agreement is in place with the AI provider**. For
a beta this should be disclosed rather than papered over.

## Backups and recovery history

Neon's history retention is the recovery window, and on the current plan it is
**6 hours**. It is also, incidentally, a retention question: data deleted at a
customer's request stops being recoverable 6 hours later, which is unusually
*good* for privacy and unusually bad for recovery. Raising the window to 7 or
30 days trades one for the other, and the trade should be made knowingly.

## What I recommend for the beta, in order

1. **Write the privacy notice.** It is the only item here a customer sees, and
   the only one that cannot be added retroactively without an awkward email.
2. **Raise Neon retention to 7 days.** Recovery matters more than the incidental
   privacy benefit of a 6-hour window.
3. **Implement archived-record purging at 30 days** — with a dry-run mode, a
   count reported before anything is deleted, and a test that a cancelled purge
   is a no-op. The workspace-deletion grace period is the model to copy.
4. **De-identify `actorEmail` on account deletion.**
5. **Decide the uploads policy before enabling uploads**, not after.

Items 3 and 4 delete customer data. Neither should be built until the exact
behaviour is approved.
