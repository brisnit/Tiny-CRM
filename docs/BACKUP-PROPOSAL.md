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

- a **read-only** Postgres role on the production branch, for `pg_dump`;
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
2. Restore into a scratch database. Apply the **14 PostgreSQL-only policy files**
   in `prisma/postgres/`; `pg_dump` carries tables and data, and RLS policies are
   applied separately here — a restore that skips them comes back with tenant
   isolation missing and looks fine.
3. Compare row counts and the fingerprint against `manifest.json`. Run the
   referential-integrity check.
4. Pull a sample of file objects, decrypt, and verify each against its manifest
   digest.
5. Record the result, with timings.

Cadence: **once before launch**, then **monthly**. A drill nobody runs is
paperwork; schedule it in the same workflow and let a failure be loud.

Known limitation, stated rather than discovered later: this exercises the
*archive*. It does not exercise Neon's point-in-time recovery, which the existing
drill covers separately.

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

## Not in this proposal, and worth deciding separately

- **Marking the production branch protected** in Neon. Free, unrelated to backups,
  and currently off.
- **A digest column on `FileAsset`.** The manifest removes the need for backup
  purposes. A stored column would additionally let the *application* detect
  drift — a different feature, needing a migration.
