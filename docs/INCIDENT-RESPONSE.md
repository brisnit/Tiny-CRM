# Incident response

What to do when something has gone wrong.

Written to be usable at 2am by whoever is on call, which means: concrete
commands, no ceremony, and the containment step before the investigation step.

**No legal promises are made here.** Notification obligations depend on
jurisdiction, contract and the data involved. Where a step says "consult",
consult; this document does not tell you what you are legally required to do.

---

## Before anything else

| | |
|---|---|
| **1. Write down the time** | Everything downstream needs a timeline. |
| **2. Preserve, do not tidy** | Do not delete rows, rotate logs, or "clean up" the attacker's traces. The audit log is append-only for this reason. |
| **3. Contain before you understand** | A stolen session ended in the first minute is worth more than a perfect root cause in the third hour. |
| **4. Assume it is worse than it looks** | Scope grows. Plan for the larger version. |

**Severity, for deciding who to wake:**

| | Meaning | Example |
|---|---|---|
| **SEV-1** | Customer data exposed, or exposure cannot be ruled out | Tenant isolation failure, database exposure, credential leak |
| **SEV-2** | A control has failed but no exposure is known | RLS off in production, rate limiting down, audit log not writing |
| **SEV-3** | Degraded, contained, no data at risk | Worker stopped, failed deploy, backup job failing |

---

## The commands you will want

```bash
# What is the state of the world
curl -s https://<host>/api/health
curl -s https://<host>/api/ready

# Is the second isolation layer actually on? (startup log, every boot)
#   "row-level security active"  or  "row-level security is NOT protecting…"

# Recent security alerts, most severe first
psql "$DATABASE_URL" -c \
  "SELECT kind, severity, count, summary, \"lastSeenAt\" FROM \"SecurityAlert\"
   WHERE \"acknowledgedAt\" IS NULL ORDER BY severity DESC, \"lastSeenAt\" DESC LIMIT 50;"

# What one actor did, in order
psql "$DATABASE_URL" -c \
  "SELECT \"createdAt\", action, summary, \"entityType\", \"entityId\", ip
   FROM \"AuditLog\" WHERE \"actorId\" = '<user id>' ORDER BY \"createdAt\" DESC LIMIT 200;"

# Every export, ever
psql "$DATABASE_URL" -c \
  "SELECT \"createdAt\", \"actorEmail\", \"workspaceId\", metadata FROM \"AuditLog\"
   WHERE action = 'data.exported' ORDER BY \"createdAt\" DESC;"

# End every session for one account, immediately
psql "$DATABASE_URL" -c \
  "UPDATE \"UserSession\" SET \"revokedAt\" = now(), \"revokedReason\" = 'admin_revoked'
   WHERE \"userId\" = '<user id>' AND \"revokedAt\" IS NULL;
   UPDATE \"User\" SET \"sessionEpoch\" = \"sessionEpoch\" + 1 WHERE id = '<user id>';"

# Disable an account outright (checked on every request)
psql "$DATABASE_URL" -c \
  "UPDATE \"User\" SET \"deactivatedAt\" = now() WHERE id = '<user id>';"

# End EVERY session for EVERY user
psql "$DATABASE_URL" -c \
  "UPDATE \"UserSession\" SET \"revokedAt\" = now(), \"revokedReason\" = 'admin_revoked'
   WHERE \"revokedAt\" IS NULL;
   UPDATE \"User\" SET \"sessionEpoch\" = \"sessionEpoch\" + 1;"
```

The epoch bump is what makes revocation instant: a token behind the user's
current epoch is refused with no session lookup at all, so it works even if the
session table is unreachable.

---

## Credential leak

*An `AUTH_SECRET`, database URL, provider key or password ends up somewhere it
should not — a commit, a screenshot, a log, a support ticket.*

**Contain**

1. Rotate the credential **first**, before deciding how bad it is. Rotation is
   cheap; the window is not.
   - `AUTH_SECRET` → generate a new one, deploy. **Every user is signed out.**
     That is the intended effect: the old secret could mint a session for
     anybody.
   - `DATABASE_URL` → change the password on the role, deploy, then confirm no
     old connections remain in `pg_stat_activity`.
   - Provider key → revoke at the provider, not just in your config. A revoked
     key is dead; an unset one is still live for whoever has it.
2. If it reached a public repository, assume it is already indexed. Rotate
   regardless of whether the commit was removed.

**Eradicate**

3. `git log -S'<fragment>' --all` to find how it got in.
4. Removing it from history (`git filter-repo`) does not un-leak it. Do it for
   hygiene, after rotating.
5. Add the shape to the secret scan if it slipped past.

**Recover**

6. Confirm the application is healthy on the new credential.
7. Post-rotation, expect a support wave from the forced sign-out. Say why.

**Notify** — consult, if the credential could reach customer data.

---

## Database exposure

*The database is reachable from somewhere it should not be, a backup is
world-readable, or a dump is found outside the environment.*

**Contain**

1. Close the path: firewall rule, revoke the public bucket, delete the artefact.
2. Rotate the database credential.
3. `SELECT * FROM pg_stat_activity WHERE backend_type = 'client backend';` — any
   connection you cannot account for.

**Investigate**

4. Establish the window: when was it exposed, and to what.
5. **A database copy defeats every application control.** RLS is an access
   control inside a running server; it does nothing for a file. Assume everything
   in that copy is readable — including password hashes and encrypted TOTP
   secrets.
6. Password hashes are bcrypt cost 12: expensive to attack, not impossible for
   weak passwords. TOTP secrets are AES-GCM under a key derived from
   `AUTH_SECRET` — if that leaked too, treat the secrets as plaintext.

**Recover**

7. Force a password reset for every affected account.
8. Revoke every session (command above).
9. Rotate `AUTH_SECRET` if a copy could contain it — it is not in the database,
   but an environment dump alongside is common.

**Notify** — consult. This is the scenario most likely to carry an obligation.

---

## Tenant isolation failure

*A customer reports seeing another customer's data, or a test/alert indicates a
cross-tenant read.*

**This is the most serious failure this product can have.** The premise of the
product is that a workspace separates businesses.

**Contain**

1. Get the specifics: which user, which workspace, which record, when, what
   screen. A screenshot is worth an hour.
2. Reproduce with the affected user's id:
   ```bash
   NODE_ENV=test npx tsx -e "…runAsTestIdentity(<id>, …)"
   ```
3. If it reproduces, take the affected code path out of service — a feature flag,
   a revert, or the whole deployment. **Do not leave a reproducible cross-tenant
   read serving traffic while you investigate.**

**Investigate**

4. Which layer failed?
   - Application (`access.ts`, a missing `assertRelations`) — the likely one.
   - RLS — only if the app connects as `tinycrm_app`; check the startup log. If
     the connection is a superuser, there was only ever one layer.
5. `SELECT ... FROM "AuditLog" WHERE "entityId" = '<record>' ORDER BY "createdAt";`
   — who touched it and from where.
6. Look for a pattern: repeated `not_found` refusals from one actor are somebody
   probing the boundary, and are alerted as `access.cross_tenant_denied`.

**Eradicate**

7. Fix, and **write the regression test first** — every isolation control in this
   codebase has one, and this is how it stays that way.
8. Run `npm test` and `npm run test:pg`.

**Recover**

9. Determine what was actually exposed, not what could have been. The audit log
   and access logs bound it.
10. If the app was not running as `tinycrm_app`, fix that now: it is the
    difference between one layer and two.

**Notify** — consult, and assume yes. Two customers are involved: the one whose
data leaked and the one who saw it.

---

## Malicious account

*An account is signing up to abuse the product, scrape it, or attack other
tenants.*

**Contain**

1. `UPDATE "User" SET "deactivatedAt" = now() WHERE id = '<id>';` — takes effect
   on the next request, because the identity is re-read from the database every
   time.
2. Revoke their sessions (command above).

**Investigate**

3. Their full audit trail. Look for: exports, imports, cross-tenant refusals,
   role changes, AI volume.
4. `SELECT * FROM "AuditLog" WHERE ip = '<their prefix>'` — other accounts from
   the same source.

**Eradicate**

5. If they created a workspace with imported data, decide whether it is theirs to
   keep. Schedule the deletion; the 7-day grace period is on your side.
6. Consider whether a rate limit or a plan limit should have caught it earlier.

---

## Stolen session

*A user reports activity they did not perform, or a session appears from an
unfamiliar network.*

**Contain**

1. Have the user go to **Settings → Security → Active sessions** and sign out
   anything unfamiliar. If they cannot, do it for them (command above).
2. Force a password reset — completing one revokes every session and bumps the
   epoch, which is the complete version of the same thing.

**Investigate**

3. `SELECT "createdAt", "lastSeenAt", "ipPrefix", "deviceLabel", "revokedReason"
   FROM "UserSession" WHERE "userId" = '<id>' ORDER BY "createdAt" DESC;`
   Addresses are truncated to a /24 or /48 by design — enough to say "not them",
   not a movement log.
4. Their audit trail for the session's lifetime. Pay attention to exports.

**Eradicate**

5. How was it taken? XSS is the usual answer, and the session cookie is
   `HttpOnly`, so consider a shared device, a phishing proxy, or a leaked token
   from a copied URL.
6. **MFA would help and is not yet enforced at sign-in** — enrolment exists, the
   sign-in challenge does not. Say so honestly to the affected user.

---

## AI provider incident

*The provider has a breach, an outage, or a change that affects retention.*

**Contain**

1. Turn AI off for the affected workspaces:
   ```sql
   UPDATE "Workspace" SET "aiMode" = 'disabled';
   ```
   Deterministic features keep working — scoring, momentum, stall detection, the
   cleanup scan, the daily brief. Only open-ended answers and free-text
   extraction stop.
2. Or globally: unset `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` and deploy. With no
   key the built-in engine runs and nothing leaves the deployment.

**Investigate**

3. What was sent, and when. `AiInsight.createdAt` bounds the summaries; the
   provider's own logs bound the rest. **Prompts are not logged here** — that is
   the right default and it does limit forensics.
4. What kinds of data: `aiDisclosure()` lists exactly what a prompt may carry.

**Notify** — customers whose workspaces had AI enabled during the window. They
chose that setting per workspace and are owed the specifics.

---

## Malicious file

*A file is uploaded that is not what it claims to be.*

**Uploads are disabled in this build** (`STORAGE_DRIVER=none`, `files` flag off).
If they have been enabled:

**Contain**

1. Turn the flag off. Existing files remain; new ones stop.
2. Delete the object from storage.

**Investigate**

3. `SELECT * FROM "FileAsset" WHERE id = '<id>';` — uploader, workspace, time.
4. Who downloaded it. Files are served with
   `Content-Disposition: attachment`, `nosniff` and `default-src 'none'`, so it
   should not have executed in the app's origin.

**Eradicate**

5. **There is no malware scanner.** `scanForMalware()` is a seam that logs its own
   absence. Set `REQUIRE_MALWARE_SCAN=true` to fail uploads closed until one is
   wired in — do this now if it is not already set.

---

## Accidental workspace deletion

**This is recoverable, and the design is why.**

1. Deletion is **scheduled**, not immediate: a 7-day grace period.
2. Cancel it — Settings, or:
   ```sql
   UPDATE "Workspace" SET "deletionScheduledAt" = NULL,
     "deletionRequestedAt" = NULL, "deletionRequestedById" = NULL
   WHERE id = '<workspace id>';
   ```
   The scheduled job re-reads the schedule and becomes a no-op.
3. Confirm: the workspace deletion request raises a `critical` alert, so there
   should be a record of when it was asked for.

**If the grace period elapsed**, this becomes *Database corruption* below: the
cascade is complete and the data is gone from the live database.

The audit entry survives — it is written before the delete and carries no
workspace id, precisely so the record of a deletion outlives the deletion.

---

## Failed deployment

**Contain**

1. Roll back to the previous release. Do this first.
2. If the server refuses to start, read the reason — the configuration gate
   prints every problem at once:
   ```
   Refusing to start: unsafe production configuration.
     1. DATABASE_URL points at a local SQLite file…
     2. APP_URL must use HTTPS in production…
   ```
   That is the gate working. Fix the configuration; do not bypass it.

**Investigate**

3. Migrations are the usual cause. `npx prisma migrate status` shows what applied.
4. A failed migration leaves a `_prisma_migrations` row marked failed. Resolve it
   deliberately (`prisma migrate resolve`) — do not delete the row.

**A note on rollback:** the application rolls back cleanly; **a migration does
not**. If the bad release added a column and the old code ignores it, rolling back
is safe. If it dropped or renamed one, rolling back the code without the data is
not. This is why migrations should be additive across a deploy boundary.

---

## Database corruption or loss

**Contain**

1. Stop writes. Scale the application to zero.
2. Do not attempt repairs on the primary. Work on a restored copy.

**Recover**

3. Restore from the most recent good backup into a **new** database:
   ```bash
   # Provider PITR is the primary mechanism; see docs/DEPLOYMENT-CHECKLIST.md
   # For a logical restore, constraints must be deferred — Company and Contact
   # reference each other and no table ordering satisfies a cycle:
   psql "$NEW_URL" -c "BEGIN; SET CONSTRAINTS ALL DEFERRED; \i dump.sql COMMIT;"
   ```
4. Verify before switching traffic. `npm run test:backup` performs exactly this
   drill — row counts, a content fingerprint, every foreign key, a
   contact → company → deal → stage → workspace walk, cross-tenant bleed, and
   the tenant-isolation suite against the restored data.
5. Point `DATABASE_URL` at the restored database and bring the app up.

**Investigate**

6. What was lost between the backup and the failure — that is your actual RPO,
   and it is worth writing down whatever it turns out to be.

**Notify** — customers whose data was lost, with the window.

---

## After: the postmortem

Within a week, while it is still accurate. Blameless — the goal is a system that
fails less, not a person who feels worse.

1. **Timeline.** First occurrence, first detection, containment, resolution. The
   gap between the first two is usually the most interesting number.
2. **What actually happened.** Mechanism, not narrative.
3. **What was exposed.** Bounded by evidence, not by assumption in either
   direction.
4. **Why the existing controls did not catch it.** Every control in this codebase
   was added because something got past. This is that conversation.
5. **What changes.** Each item with an owner. **A fix without a regression test
   is not a fix** — that is the standing rule here, and it is why the isolation,
   session, token and alerting controls each have tests written as attacks.
6. **What we got right.** Also worth knowing.

Add the finding to `docs/PRODUCTION-READINESS.md` if it changes a grade.

---

## What is missing

Stated plainly, because an incident is a bad time to discover it:

- **No alerting is delivered by default.** `SecurityAlert` rows are written and
  logged; without `ALERT_WEBHOOK_URL` nobody is woken.
- **No on-call rotation, no escalation path, no status page.** These are
  organisational, not code, and they do not exist.
- **No security contact.** Add one to `SECURITY.md` at the repository root before
  taking customer data — including how someone outside reports a vulnerability.
- **No log retention policy**, so "check the logs from three weeks ago" may have
  no answer.
- **MFA is not enforced at sign-in**, so "make them turn on 2FA" is not currently
  a containment step.
- **No verified provider-level restore.** The drill in this repository proves the
  data round-trips; it has not been run against a real managed backup.
