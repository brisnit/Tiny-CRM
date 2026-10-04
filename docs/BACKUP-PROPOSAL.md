# Off-provider backup — proposal

**Nothing in this document has been bought, enabled, or changed in production.**
It is a design for review. The credentials it describes do not exist yet, and no
account has been opened.

---

## The gap this closes

`docs/NEON-RECOVERY-DRILL.md` established what recovery exists today, and it is
narrower than "we have backups" suggests:

| | |
|---|---|
| Point-in-time recovery | **6 hours** (Neon free plan history retention; confirmed in the console and in Neon's published plan limits) |
| Mechanism | Branch from a historical timestamp — copy-on-write **inside one Neon project** |
| Independent copy | **None** |
| Production branch protection | Not enabled |
| Uploaded files (R2) | No copy of any kind |

What that covers: a bad migration or a wrong delete, noticed within six hours.

What it does not cover, at all:

- a deletion noticed on Monday that happened on Friday;
- loss of the Neon account, or the project being deleted;
- a provider-side failure or a billing lapse that suspends the project;
- **anything happening to the R2 bucket**, which holds customer files and has no
  second copy anywhere;
- a slow-burn corruption that is already inside the six-hour window by the time
  anyone notices.

A CRM holds other people's customer records. The absence of an independent copy
is the single largest recoverability gap in the system, larger than the six-hour
window, because a longer window still lives in the same account.

---

## Scope

**In scope**

1. **Database records** — a logical dump of the production branch. 52 models.
2. **R2 objects** — every file in `tiny-crm-documents`. Keys are
   `workspaces/<workspaceId>/<uuid>.<ext>` (`storageKeyFor` in
   `src/lib/uploads.ts`), so a listing is already tenant-partitioned.
3. **A manifest** tying the two together, and making a restore checkable.

**Out of scope, deliberately**

- **The application.** It is in git and rebuilt by Vercel. Backing up a build is
  backing up a derived artifact.
- **Secrets.** `AUTH_SECRET`, the R2 keys, `DATABASE_URL` and the rest belong in a
  password manager. Putting them in the same archive as the data means one
  compromise yields both.
- **The backup's own encryption key** — see below. If it lives in the backup, the
  encryption is decoration.

---

## Design

### 1. Target: one off-provider bucket

The constraint is independence, and it differs per payload:

- the database copy must not live at **Neon**;
- the file copy must not live at **Cloudflare**, since that is where the only
  current copy already is.

One bucket satisfying both. **Backblaze B2** is the recommendation:
**$6.95/TB/month** storage, free egress up to 3× stored bytes then $0.01/GB, and
explicitly *no minimum storage duration fee* — which matters, because short
retention tiers on providers that bill a 30- or 90-day minimum silently cost the
minimum. AWS S3 in a separate account is the equivalent alternative and costs
more; S3 Glacier tiers are cheaper to hold and slower and fiddlier to restore
from, which is the wrong trade for a copy whose whole job is to be restorable
under stress.

### 2. Encryption: client-side, before upload

Encrypt locally with **`age`**, to a public key, and keep the private key in a
password manager — never in Vercel, never in the backup bucket, never in the repo.

Provider-side encryption (SSE) protects against someone stealing a disk. It does
not protect against a compromised backup account, which is the realistic threat
for a bucket holding a full copy of the database. Client-side encryption means the
bucket cannot read what it stores.

The cost of this is real and must be stated: **an encrypted backup you cannot
decrypt is not a backup.** The restore drill below therefore exercises the key,
not just the data, and the key needs a documented second copy held somewhere
other than the first.

### 3. What each run writes

```
tinycrm-backup/<UTC timestamp>/
  db.dump.age          pg_dump -Fc of the production branch, encrypted
  manifest.json.age    see below, encrypted
objects/<sha256>.age   file objects, content-addressed, encrypted, shared
                       across runs
```

`manifest.json` carries:

- run timestamp, and the migration head the dump was taken at;
- SHA-256 of the database dump;
- per-table row counts;
- for every `FileAsset`: `storageKey`, `sizeBytes`, and the **SHA-256 of the
  object bytes**.

That last field is the reason the manifest exists. `FileAsset` stores
`sizeBytes` and **no digest column**, so nothing in the system can currently tell
a correct file from a same-length corrupt one. The backup computes the digest
itself, which gets content verification with **no schema change and no
migration** — worth noting, because the obvious alternative was a migration.

Objects are stored under their own digest rather than per run, so an unchanged
file is stored once no matter how many runs reference it. This is what keeps the
cost flat as retention grows.

### 4. Where it runs

**Not in the application.** A scheduled job inside the app with production
credentials is a new blast radius reachable from the request path.

**A scheduled GitHub Actions workflow** is the recommendation: credentials live in
repo secrets, every run is logged and attributable, and failures are visible
without building anything. It needs two **new, narrower** credentials rather than
reuse of the app's:

- a Postgres role carrying **`BYPASSRLS`** on the production branch, for
  `pg_dump`. Not a new least-privilege role: one cannot be created on Neon, and
  ownership does not substitute. See *Verified* §6;
- an R2 token scoped **read-only to the one bucket**.

The app's own credentials are read-write. A backup job never needs to write to
either system, and a backup job that *can* is a way to lose both copies at once.

### 5. Frequency — and the constraint that actually binds

Neon's free plan includes **5 GB of egress per project per month**. A nightly full
dump multiplies the dump size by ~30. The dump is much smaller than the stored
size — `pg_dump -Fc` excludes indexes and compresses — but *how much* smaller is
unmeasured, and that measurement decides this:

| Measured dump size | × 30 nightly | Verdict against 5 GB |
|---|---|---|
| 50 MB | 1.5 GB | Nightly is fine |
| 150 MB | 4.5 GB | Nightly fits, with no headroom |
| 250 MB | 7.5 GB | Nightly exceeds it — weekly full, or pay |

The R2 side has no such problem: **egress from R2 is free**, and the free tier
covers 10 M Class B reads a month, far more than this needs.

Proposal: **weekly full, plus nightly once the dump size is measured and the
arithmetic clears** — not the other way round.

Related, and complementary rather than alternative: Neon's **Launch** plan raises
history retention to **7 days** and includes **500 GB of egress per project**,
removing the constraint above. It is usage-based ($0.106/CU-hour, $0.35/GB-month
storage) with no monthly minimum. A longer PITR window and an independent copy
solve different problems, so this is not a substitute for the proposal — but if
the egress table above lands badly, it is the cheaper fix.

### 6. Retention

| Tier | Keep | Why this tier exists |
|---|---|---|
| Daily | 7 | The six-hour window fails on "happened Friday, noticed Monday". The nearest copy must be under a day old. |
| Weekly | 4 | A corruption that is subtle enough to survive a week needs a pre-corruption copy. |
| Monthly | 3 | Slow-burn damage, and a floor under the whole chain. |

Then stop. 14 database dumps; file objects are deduplicated, so they are held once
plus churn.

**One thing this must not do is quietly contradict the privacy notice.** A record
the customer deleted stays in these backups until it ages out of the tier that
holds it — up to three months under the table above. `docs/RETENTION.md` already
makes this point; it becomes concrete the moment this exists, and any erasure
commitment has to be worded for it. Privacy §8 currently states the 6-hour
recovery window and explicitly declines to claim deleted data is gone after it.
That wording stays correct under this proposal, which is partly why it was written
that way.

### 7. Restore testing

An untested backup is a hypothesis, and this one adds a second hypothesis — that
the key works.

The drill, reusing what already exists rather than writing it again.
`scripts/backup-test.mjs` already implements `tableCounts`, `fingerprint` and
`checkReferentialIntegrity`:

1. Fetch the newest archive. **Decrypt it** — from the password manager, by hand,
   the way it would happen in an incident.
2. **Create the `tinycrm_app` role, then restore.** That order is the whole of it.
   `pg_dump` carries the policies, the RLS flags, the functions, the indexes and
   the grants; it does **not** carry the role, because roles are cluster-global.
   Restoring with the role absent exits 1, keeps going, and silently drops every
   privilege — see *Verified* below. The 14 files in `prisma/postgres/` do **not**
   need reapplying.
3. Compare row counts and the fingerprint against `manifest.json`. Run the
   referential-integrity check.
4. **Assert the security posture, not just the data.** Policy count, the count of
   tables with RLS forced, and `relacl` on `AuditLog`. Then behaviourally, as
   `tinycrm_app`: no workspace context returns zero rows; a context returns only
   that workspace's rows; `UPDATE` and `DELETE` on `AuditLog` are refused.
5. Pull a sample of file objects, decrypt, and verify each against its manifest
   digest.
6. Record the result, with timings.

Cadence: **once before launch**, then **monthly**. A drill nobody runs is
paperwork; schedule it in the same workflow and let a failure be loud.

Known limitation, stated rather than discovered later: this exercises the
*archive*. It does not exercise Neon's point-in-time recovery, which the existing
drill covers separately.

---

## Verified

The two paragraphs above were originally written from assumption, and one of them
was wrong. Both were then tested on a real PostgreSQL 17.10 cluster with the full
schema — 11 migrations, all 14 SQL files, 56 policies, 44 tables with RLS enabled
and forced, 12 `app_*` functions, 219 indexes — and a two-workspace fixture.
`pg_dump`/`pg_restore` 18.6.

### 1. A dump taken correctly carries the whole security posture

Counted in the emitted SQL, against the live catalogue:

| Object | In the database | In the dump |
|---|---|---|
| `CREATE POLICY` | 56 | **56** |
| `ENABLE ROW LEVEL SECURITY` | 44 | **44** |
| `FORCE ROW LEVEL SECURITY` | 44 | **44** |
| `app_*` functions | 12 | **12** |
| Indexes | 219 | **219** after restore |
| Tables with an ACL for `tinycrm_app` | 53 | **53** |
| `CREATE ROLE` | 1 role | **0** |

So the earlier instruction to reapply all 14 files by hand was wrong. The policy
files are *how the database got that way*; they are not needed to put it back.

### 2. What is missing is the role, and its absence is quiet

Restoring the same dump into a cluster where `tinycrm_app` did not exist:
`pg_restore` **exit 1, 56 errors, all `role "tinycrm_app" does not exist`** — and
it continued. The result had the full schema, all 56 policies, RLS forced on all
44 tables, all 219 indexes and all 3 fixture rows, with **`relacl` NULL on every
table**: zero privileges for the application role, and the `AuditLog` append-only
revoke gone with the rest.

That is the failure mode to design against. It is not a restore that fails; it is
a restore that looks complete, passes a row-count check, and cannot be used —
with the append-only guarantee missing.

### 3. The least-privilege instinct breaks the dump

This is the correction that matters, because the wrong choice is the one that
looks responsible. `tinycrm_app` is `NOBYPASSRLS` by design, and every tenant
table is `FORCE ROW LEVEL SECURITY`.

| Dumping role | Result |
|---|---|
| Owner / superuser | exit 0, 254,973 bytes |
| Read-only, **`BYPASSRLS`** | **exit 0, 262,059 bytes — restores to an identical posture** |
| Read-only, `NOBYPASSRLS` | **exit 1** — `query would be affected by row-level security policy for table "Activity"` |
| `tinycrm_app` | **exit 1** — same error |
| `tinycrm_app` + `--enable-row-security` | **exit 1** — `function app_workspace_ids() does not exist`, because `pg_dump` runs with a restricted `search_path` the policy's function cannot resolve under |

Two consequences:

- A backup role needs `BYPASSRLS`, or table ownership. A plain read-only role
  cannot back this database up at all. Granting `SELECT` is not enough when RLS is
  forced.
- **`--enable-row-security` must never be used here.** Its documented behaviour is
  to dump only the rows the role can see. Under deny-by-default that is *zero
  rows*, and the only reason this attempt failed loudly rather than silently was
  an unrelated `search_path` problem. A silently empty backup is the worst
  outcome in this document.

### 4. Every failing run left a partial file behind

| Run | Exit | File left on disk |
|---|---|---|
| `tinycrm_app` | 1 | 252,156 bytes |
| Read-only `NOBYPASSRLS` | 1 | 259,242 bytes |

A truncated dump within 3% of a good one's size. Any size or existence check
passes it. **The job must gate on the exit code and delete the artefact on
failure**, and the manifest's digest is what makes a truncated upload detectable
afterwards.

### 5. The restored database preserves tenant isolation and role permissions

Restored from the read-only `BYPASSRLS` dump, then exercised as `tinycrm_app`:

| Check | Result |
|---|---|
| No workspace context | **0 of 3** contacts visible |
| Context `w_a` | exactly `c_a1, c_a2` |
| Context `w_b` | exactly `c_b1` |
| Context `w_a, w_b` | all three |
| `AuditLog` `relacl` | `tinycrm_app=ar/tinycrm` — INSERT + SELECT, identical to the original |
| `UPDATE "AuditLog"` | `ERROR: permission denied for table AuditLog` |
| `DELETE "AuditLog"` | `ERROR: permission denied for table AuditLog` |
| `app_claim_jobs`, `app_workspace_ids` | executable |

Deny-by-default survives the round trip, scoping is exact, and the append-only
audit log is still append-only.

### 6. Permissions on Neon, from the providers' own documentation

Two things were checked here rather than assumed, and the first corrects a
sentence in an earlier draft of this document.

**Table ownership does not help.** PostgreSQL's documentation is explicit:

> "Superusers and roles with the `BYPASSRLS` attribute always bypass the row
> security system when accessing a table. Table owners normally bypass row
> security as well, though a table owner can choose to be subject to row security
> with `ALTER TABLE ... FORCE ROW LEVEL SECURITY`."

`FORCE ROW LEVEL SECURITY` is exactly what `002_row_level_security.sql` sets on
all 44 tenant tables, and the reason it is set is that the owner must not be an
exception. So "`BYPASSRLS`, or table ownership" was wrong: under FORCE, **only a
superuser or a `BYPASSRLS` role can produce a complete dump.** The local
experiment did not catch this, because the owner there was also the cluster
superuser — two attributes in one role, and the wrong one got the credit.

The same page settles the dump flag:

> "By default, `pg_dump` will set `row_security` to `off`, to ensure that all data
> is dumped from the table. If the user does not have sufficient privileges to
> bypass row security, then an error is thrown." `--enable-row-security`
> "instructs `pg_dump` to set `row_security` to `on` instead of the default `off`,
> allowing the user to dump the parts of the contents of the table that they have
> access to."

"The parts … that they have access to", under deny-by-default, is nothing.

**What Neon provides.** From Neon's own documentation:

| Fact | Consequence here |
|---|---|
| `neon_superuser` includes **`BYPASSRLS`** — "This attribute is only included in `neon_superuser` roles in projects created after the August 15, 2023 release" | The capability exists on this project, which was created in 2026 |
| `neon_superuser` does **not** have `SUPERUSER`, and is `NOLOGIN` | You never connect as it directly |
| Roles created via the Neon Console, CLI or API receive `neon_superuser` membership; roles created with plain SQL get only basic public-schema privileges | The console-created role is the one with a chance of working |
| `neon_superuser` "cannot run `ALTER OWNER` statements" | Ownership cannot be reassigned to a backup role anyway |
| PostgreSQL: "`CREATEROLE` does not confer the ability to grant or revoke the `BYPASSRLS` privilege", and a `BYPASSRLS` role is created "as a superuser" | **A new `BYPASSRLS` role cannot be minted on Neon.** `neon_superuser` has `CREATEROLE` but not `SUPERUSER` |

So the design changes: there is no separate least-privilege backup role to create.
The dump must run as a role that already carries `BYPASSRLS` through
`neon_superuser` — which the existing Neon-created role does.

**The one thing documentation cannot settle.** `BYPASSRLS` is a role *attribute*.
Neon's documentation says a console-created role gets `neon_superuser`
*membership*, and PostgreSQL's page describes `BYPASSRLS` as a privilege while
stating only that "a role inherits the privileges of roles it is a member of, by
default" — it does not say whether this particular attribute takes effect through
membership or only when set directly on the connecting role. That distinction
decides whether the existing role can back this database up, and no page consulted
answers it.

It is settled by a read-only probe, which creates nothing and changes no
permission. Against the production branch, as the role the backup would use:

```sql
-- 1. Does the connecting role carry it directly, or reach it by membership?
SELECT current_user, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user;
SELECT pg_has_role(current_user, 'neon_superuser', 'USAGE') AS in_neon_superuser;

-- 2. The decisive one: this is the exact mechanism pg_dump uses.
--    A count means the dump will succeed. An error means it will not.
SET row_security = off;
SELECT count(*) FROM "Contact";
```

If step 2 returns a number, `pg_dump` will produce a complete dump as that role.
If it raises `query would be affected by row-level security policy`, it will not,
and the only remaining options are a Neon paid tier, a logical-replication reader,
or export through the application rather than the database.

Neon's own `pg_dump` guidance adds one requirement worth carrying into the design:

> "Avoid using `pg_dump` over a pooled connection string" — use an unpooled one.

Which is also a reminder that the application's `DATABASE_URL` is probably the
pooled endpoint, so the backup job needs a different host string. That connects to
the open question about which branch the deployed app talks to, recorded as gap 6
in `docs/DPA-DRAFT.md`.

Neon's migration documentation contains **no guidance about row-level security at
all**, so none of the above is something a reader of their docs would be warned
about.

### What now runs in CI

`scripts/backup-roundtrip-pg.mjs`, added to the existing *Backup and restore* job,
so the properties above stop depending on anyone remembering them. It does a real
`pg_dump` → `pg_restore` into an empty database and then asserts, in order:

1. a tripwire that `FORCE ROW LEVEL SECURITY` is actually binding — without it
   every isolation assertion below would pass on a database that had no RLS at
   all;
2. `pg_dump` exit status, deleting the artefact if it failed;
3. `pg_restore` exit status **and** stderr, because the role-absent case exits
   non-zero having restored nearly everything;
4. policy count, RLS enabled and forced counts, `app_*` function count, index
   count, the number of tables granting the app role, and `AuditLog`'s `relacl`,
   each identical between source and restore;
5. isolation as the application role: no context sees nothing, each workspace sees
   only its own rows, both sees both;
6. `UPDATE` and `DELETE` on `AuditLog` refused, `SELECT` still permitted,
   `app_claim_jobs` still executable.

It changes no roles: it borrows the application identity with `SET ROLE`, which
binds RLS and table privileges exactly as a real connection would.

Mutation-tested, because assertions that cannot fail are worse than none:
restoring with `--no-acl` fails it on `tables_granting_app 53 → 0` and on the
`AuditLog` ACL — the role-absent failure mode exactly; pointing `pg_dump` at a
missing database fails it on the exit status and reports the partial file
deleted; and clearing `FORCE ROW LEVEL SECURITY` on one table fails the step-1
tripwire.

Tooling note: `pg_dump` is not on this machine by default — the embedded
PostgreSQL package ships only `initdb`, `pg_ctl` and `postgres`. These runs used
Homebrew `libpq` 18.6.

### 8. Cost

Storage at B2's $6.95/TB/month ⇒ **$0.00695/GB/month**.

```
monthly ≈ ((14 × dump_size) + deduped_file_bytes) × $0.00695/GB
```

Worked at plausible figures, pending measurement:

| dump size | R2 bytes | Held | Monthly |
|---|---|---|---|
| 100 MB | 1 GB | 2.4 GB | **$0.02** |
| 200 MB | 5 GB | 7.8 GB | **$0.05** |
| 500 MB | 20 GB | 27 GB | **$0.19** |
| 2 GB | 100 GB | 128 GB | **$0.89** |

Egress to write the backup is free from R2 and counts against Neon's 5 GB on the
database side. Restores pull from B2, where egress is free up to 3× stored bytes —
far beyond a monthly drill.

**Cost is not the obstacle.** At this scale it rounds to nothing. The real costs
are the two new credentials, the key custody, and a drill that someone has to
keep honest.

---

## Measure before committing

Three read-only numbers decide the frequency and confirm the cost. Neither
changes anything:

```bash
# 1. Dump size — the number the egress table turns on.
#    Against the production branch, read-only role preferred.
pg_dump -Fc "$DATABASE_URL" | wc -c

# 2. R2 object count and total bytes.
aws s3 ls --recursive --summarize \
  --endpoint-url "$S3_ENDPOINT" s3://tiny-crm-documents | tail -2

# 3. What the database thinks it has, to compare against (2).
#    A mismatch is itself a finding: a row with no object, or an
#    object with no row, is a bug rather than a backup problem.
#    SELECT count(*), sum("sizeBytes") FROM "FileAsset";
```

---

## Decisions for you

1. **Target provider** — Backblaze B2 as proposed, or AWS S3 in a separate
   account.
2. **Where it runs** — scheduled GitHub Actions as proposed, or somewhere else.
3. **Key custody** — which password manager holds the `age` private key, and where
   the second copy lives.
4. **Frequency** — weekly now and nightly after measurement, or nightly from the
   start on a paid Neon plan.
5. **Retention** — 7 / 4 / 3 as proposed, noting it sets a floor under any erasure
   commitment.
6. **Whether to also buy a longer PITR window** (Neon Launch, 7 days). Different
   problem, complementary, and it removes the egress constraint.
7. **What to do if the `row_security = off` probe in §6 fails.** The fallbacks are
   a Neon paid tier, a logical-replication reader, or exporting through the
   application instead of the database — all more work than this proposal assumes.

## Not in this proposal, and worth deciding separately

- **Marking the production branch protected** in Neon. Free, unrelated to backups,
  and currently off.
- **A digest column on `FileAsset`.** The manifest removes the need for backup
  purposes. A stored column would additionally let the *application* detect
  drift — a different feature, needing a migration.
- **Whether the restore drill belongs in CI.** The security assertions in step 4
  are the ones that decay silently, and they are cheap: CI already provisions a
  PostgreSQL cluster with all 14 SQL files applied, so a dump → restore →
  assert-posture cycle would fit the existing *Backup and restore* job. That would
  catch a future migration that adds a table without RLS, which no current test
  does from the restore side.
