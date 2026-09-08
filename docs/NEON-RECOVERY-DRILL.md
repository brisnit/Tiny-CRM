# Neon recovery drill

Performed 2026-09-08 against the live project. This is the record of the one
thing `npm run test:backup` could never establish: that the **provider** can
reconstruct a past state, and that what comes back is still a correctly
isolated, referentially intact database.

Harness: `scripts/restore-probe.mjs`. Repeatable — `seed`, `verify`,
`fingerprint`, `cleanup`.

## What was exercised

| | |
|---|---|
| Neon plan | **Free** (`free_v3`), 10-branch limit, 512 MiB branch size limit |
| Project | `Tiny CRM` / `weathered-cherry-25475190`, `aws-us-west-2` |
| Engine | PostgreSQL **18.6** |
| History retention (PITR window) | **21600 s = 6 hours** |
| Recovery method | **Branch from a historical timestamp** — a new isolated branch, never a restore over production |
| Source recovery timestamp | `2026-09-08T17:22:25Z` (WAL LSN `0/2241CF0`) |
| Branch resolved to | `parent_timestamp 2026-09-08T17:22:16Z`, `parent_lsn 0/2241D28`, `init_source parent-data` |
| Branch creation (API ack) | **688 ms** |
| Branch + endpoint ready | **2668 ms** |

Neon resolves a requested timestamp to the last LSN at or before it, so the
recorded branch point is a few seconds earlier than requested. The recorded
`parent_lsn` is *after* the fixture's commit LSN, which is what makes the
result meaningful; a drill that branched before its own fixture would verify
nothing and still print green.

## Result

**38 assertions passed, 0 failed**, identically on production before the
recovery point and on the restored branch afterwards.

| Check | Result |
|---|---|
| Schema identical to production | 47 tables, 539 columns, 464 constraints, 42 policies, 190 indexes — hash-identical |
| Fixture rows restored | 24 / 24 |
| Deterministic fingerprint | `1a371684…99fe92` — **matches the source exactly** |
| Referential integrity | all 6 relationship checks, including the circular `Company ↔ Contact` FK |
| RLS enabled *and* forced | 28 workspace-owned tables, 1 documented exclusion |
| Runtime role | `tinycrm_app`, `rolsuper=false`, `rolbypassrls=false` |
| A→A, B→B | succeed across Contact, Company, Deal, Task, Note, AuditLog, SecurityAlert |
| A→B, B→A | refused across all seven |
| Audit / security evidence | `AuditLog` and `SecurityAlert` rows restored and workspace-scoped |

Isolation was asserted **only** over the restricted role. The harness reads
`rolsuper` and `rolbypassrls` on its own connection and exits if either is
true: the same assertions run over a BYPASSRLS connection produce identical
PASS lines while proving nothing, which is the most dangerous shape a passing
test can take.

## Production afterwards

Cleanup deletes by recorded id only — never by the `RESTORE_PROBE` marker,
because a `LIKE` on a name would delete anything a real user happened to call
that. 24 rows removed, 0 probe rows left, legitimate data intact (3 users,
1 workspace, 51 audit entries, 3 alerts), no orphaned foreign keys.

Health `ok`, ready `true`, hosted RLS 17 passed / 0 failed / 1 skipped. The
skip is the SQL cross-tenant check, which needs two workspaces and therefore
cannot run once the fixture is removed — that skip is a consequence of a
successful cleanup, and the isolation evidence above was taken while the
fixture existed.

## Limitations — read these before relying on this

1. **The PITR window is 6 hours.** This is the free plan's history retention
   and it is the binding constraint on recovery, not anything in this
   application. Data destroyed on a Friday and noticed on a Monday **cannot be
   recovered**. For a product holding other people's customer records that is
   the single most important number on this page, and a paid plan (7 or 30
   days) is the fix.
2. **No independent copy exists.** Branching is copy-on-write *within* the
   project. It recovers from an application-level mistake — a bad migration, a
   wrong delete — and not from account loss, project deletion, or a provider
   failure. An export stored elsewhere is a different control and is not in
   place.
3. **The production branch is not marked protected.** Neon offers branch
   protection; enabling it on `production` would prevent an accidental reset.
4. **The drill restored a purpose-built fixture, not a full customer dataset.**
   24 rows across 12 tables. It proves the mechanism, the schema, the policies
   and the isolation survive. It does not measure restore time at scale.
5. **`pg_dump` was never exercised.** No client binaries on the verification
   machine, and Neon's engine is 18.6 while the local cluster is 17.10, so a
   dump could not be restored locally anyway.
