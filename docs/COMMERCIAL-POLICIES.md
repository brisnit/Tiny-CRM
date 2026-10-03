# Commercial policies — decisions of record

Approved 2 October 2026. This file exists so that the wording on
`/privacy` and `/terms` can be traced to a decision, and so that the things
that were *not* decided are not mistaken for things that were.

Both legal pages remain marked **draft** until the clauses listed under
"Still for counsel" are written.

---

## Approved

### 1. Cancellation, refunds and proration — approved

- Cancelling gives **no refund or credit for unused time**. The plan runs to the
  end of the period already paid for, then the account moves to Free.
- A **downgrade produces a credit**; an **upgrade produces an additional
  charge**. Not every plan change produces a credit, and the terms say so
  separately rather than using the word "prorated" to cover both.
- Either adjustment appears on the **next invoice**, not immediately.
- A charge taken in error is refunded.

Verified against the configuration, not assumed: the portal's
`subscription_cancel` is `at_period_end` with `proration_behavior: "none"`, and
`subscription_update` uses `create_prorations`.

Written into: terms § 4.

### 2. Notice of change — approved

At least **30 days' notice by email to the account address** before a price
increase or a material change to the terms or the privacy notice applies to an
existing subscription.

Email is named deliberately. The earlier draft said "notice in the product",
which nothing implements: `notification.create` appears only in `automations.ts`
and `jobs/handlers.ts`, neither of which is an announcement channel. A notice
commitment resting on a mechanism that does not exist would not have been kept.

Written into: terms § 3 and § 11, privacy § 12.

### 5. Availability — approved

**No availability commitment and no SLA**, stated as a deliberate choice: a
single-region deployment without an on-call rota should not publish a number.
Database recovery has been tested, but it is 6 hours of in-project point-in-time
recovery rather than an independent backup, and no recovery-time guarantee is
offered. The earlier wording ("backups exist and have been restore-tested")
overstated it and has been corrected on both pages.

Written into: terms § 8, privacy § 10.

### 6. Company registration and tax identifiers — approved: omit

No registration number or tax identifier is published on the legal pages. The
operator, address and contact are published and are sufficient to identify the
party. Nothing on either page implies that an identifier is forthcoming.

Sales tax / VAT *handling* is a separate question and stays with counsel
(terms § 4).

---

## 3. Retention — recorded as current implementation, not as approved policy

This is the important distinction in this file. Section 8 of the privacy notice
now describes **what the service does today**, read from the code. It is
explicitly **not** an approval of indefinite retention as a permanent policy,
and the page says so in its first sentence.

Verified behaviour:

| Data | Behaviour | Source |
|---|---|---|
| Expired sessions, used/expired auth tokens | Deleted on the daily sweep | `jobs.ts` → `sweep()` |
| Completed background jobs | Deleted 30 days after processing | `sweep()` |
| Expired idempotency keys, rate-limit counters | Deleted on the sweep | `sweep()` |
| Security alerts | Deleted **365 days after acknowledgement**; an unacknowledged alert is kept indefinitely | `sweep()` |
| Audit log | **Never deleted by any code path.** The app's DB role is denied `UPDATE`/`DELETE` on the table | schema + policies |
| Trash | **Never emptied.** `TRASH_RETENTION_DAYS = 30` is declared in `workspaces/policy.ts` and referenced nowhere else | grep |
| Customer business records | Kept until the customer deletes them | `sweep()` comment |
| Workspace deletion | Scheduled, **7-day** cancellable grace period, then cascades | `WORKSPACE_DELETION_GRACE_DAYS` |
| Account closure | **Does not exist in the product** | no `user.delete`, no route |
| Point-in-time recovery | **6 hours** — Neon free-plan history retention | Neon console; `docs/NEON-RECOVERY-DRILL.md` |
| Independent off-provider copy | **None.** Branching is copy-on-write inside one project | `docs/NEON-RECOVERY-DRILL.md`; proposal in `docs/BACKUP-PROPOSAL.md` |

Audit retention (indefinite) and security-alert retention (365 days after
acknowledgement) are stated as two separate rules on the page, because they are
two separate rules in the code.

**The recovery window is now known: 6 hours.** It is recorded as a *point-in-time
recovery window* and deliberately not as proof that deleted data disappears after
six hours — those are different claims, and only the first is supported. What the
provider keeps in its own storage layers beyond that window remains the one gap
marker in privacy § 8.

Two things that number changes. First, it was **already in the repository** at
`docs/NEON-RECOVERY-DRILL.md:18` while being treated here as unread — a
propagation failure, not a missing fact. Second, the same drill records that **no
independent copy exists**: Neon branching is copy-on-write inside one project, so
it covers an application mistake and not account loss or provider failure, and an
export held elsewhere is a control that is not in place.

The export claim was also corrected here. "Export everything as CSV" was false.
Six exports exist — contacts, companies, deals, projects, opportunities, tasks —
each capped at `LIMITS.maxExportRows = 50_000` and each filtered
`archivedAt: null`, so trashed records are excluded. Timeline notes, activity
history, uploaded files, tags and custom field values have no export path.

---

## 4. Data processing addendum — not promised

`docs/DPA-DRAFT.md` exists for review. It is **not** offered to customers and
neither page states that a DPA is available; the privacy notice still marks the
question as a business decision.

The draft's own section 7 is the reason: the obvious deletion clause cannot be
honoured while account closure does not exist, trash is never purged and audit
records are never deleted.

---

## Follow-up work, tracked separately

These are consequences of the above, not caveats on it. None is started.

1. **Complete customer-data export.** Today six entity exports, capped at 50,000
   rows, excluding trashed records, with no notes, activity, files, tags or
   custom values. A data-subject request for "everything" cannot presently be
   satisfied from the product.
2. **Safe account closure.** It does not exist. It cannot be built naively:
   `Workspace.owner` is `onDelete: Cascade`, so deleting an owner would destroy
   every workspace they own — including workspaces other people are members of,
   taking those members' data with it. Closure must transfer ownership or refuse
   while other members remain.
3. **Retention controls.** Enforce `TRASH_RETENTION_DAYS` or keep describing
   trash as indefinite; decide an audit-log term deliberately. The recovery
   window is now known (6 hours) — what is open is whether to pay for a longer
   one, whether to hold an independent export elsewhere, and what the provider
   keeps beyond the window.
4. **A reliable notice process.** The 30-day email commitment in item 2 now
   depends on one. There is no announcement mechanism and no way to mail all
   subscribers from the product; today it would be done by hand.

## Still for counsel

Governing law and jurisdiction, the controller/processor split, the warranty
disclaimer and limitation of liability, indemnities and caps, breach-notification
timelines, sales tax / VAT handling, statutory data-subject rights, suspension
notice and appeal, cookie consent, and the AI provider's contractual retention
position.
