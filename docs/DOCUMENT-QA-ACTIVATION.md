# Activation plan — file uploads and Document Q&A

The plan to turn two flags on, in order, with the check that gates each step and
what to do when one fails. **Nothing here has been done.** Both flags are off,
nothing is merged, and the scanner is not provisioned.

Read `docs/MALWARE-SCANNING.md` first for the scanner itself; this document is
the sequence around it.

---

## What is already proven, and what is not

| | Status | Evidence |
|---|---|---|
| Document answers are accurate | **passed** | 13 supported questions across 3 documents, each answered correctly with the right page cited, against Claude |
| Unsupported questions are refused | **passed** | 10 of 10 unsupported and misleading questions declined, naming what was searched; no fabricated figures |
| Cross-workspace isolation | **passed** | PostgreSQL + RLS, in CI |
| Upload → ingest → ask | **passed** | real object storage, real PDFs, locally |
| ClamAV detects malware | **passed (software)** | real ClamAV 1.5.4, full signature set: pure EICAR → `Eicar-Test-Signature` |
| Scanner authentication | **passed** | 401 for absent, wrong, and wrong-but-right-length tokens; `/health` too |
| Stale signatures refuse | **passed** | signatures backdated 30 days → `/health` 503, every scan refused |
| Outage refuses | **passed** | `clamd` stopped → gateway 502 → the adapter throws → upload refused |
| **The hosting** | **NOT DONE** | needs provisioning; see §1 |
| **Production behaviour** | **NOT DONE** | nothing has run in production |

Everything in the "passed" rows ran locally or in CI. None of it exercised the
Fly machine, its TLS certificate, its volume, `freshclam` on its own timer, or
Vercel reaching across the internet to it. That is what §1–§3 are for.

---

## 1. Provision the scanner

**Approved at up to $12/month. The measured total is $11.15–$11.56**
($10.70–$11.11 for `shared-cpu-1x` with 2 GB, plus $0.45 for a 3 GB volume).
`docs/MALWARE-SCANNING.md` §6 has the commands.

**Stop and come back if `fly` quotes more than $12/month** at any point — in
particular if it will not sell a 2 GB `shared-cpu-1x` at the rate above, or if
the organisation carries a support plan ($29 or $99/month) that was not in the
estimate.

`flyctl` is not installed on this machine, and provisioning needs your login,
your organisation and a payment method. This step is yours.

**Gate:** `fly status` shows one machine, and `/health` returns 200 with a
`signatureAgeHours` under 48.

---

## 2. Prove the deployed scanner

`docs/MALWARE-SCANNING.md` §7, all five checks, against the real URL.

**Check 2 — pure EICAR returning `FOUND` — is the only step in either document
that establishes ClamAV is scanning in production.** Use pure EICAR, not a PDF:
real ClamAV reports `OK` for a PDF-wrapped EICAR, verified locally, because the
header changes the file's type.

**Gate:** check 2 returns `{"Status":"FOUND","Description":"Eicar-Test-Signature"}`.

**If it returns `OK`:** the signature database has not loaded. Check `fly logs`
for `freshclam`, and `/health` for the age. Do not proceed.

---

## 3. Point production at it, still with uploads off

Vercel → Production only:

```
MALWARE_SCANNER_URL   = https://tiny-crm-scanner.fly.dev/scan
MALWARE_SCANNER_TOKEN = <the SCANNER_TOKEN value>
```

Redeploy. Then, and only then:

```
REQUIRE_MALWARE_SCAN  = true
```

Redeploy again. The order matters: the second variable without the first is
refused at boot by the configuration gate, deliberately, so a deployment that
believes it scans cannot start without a scanner.

**Gate:** the boot line appears, and the warning
`Object storage is configured but MALWARE_SCANNER_URL is not` is gone.

Uploads are still off — the `files` flag is `false` — so nothing is scanned yet
and nothing customer-facing has changed.

---

## 4. Merge the branch

`feat/document-qa-readiness`, draft PR #32. Merging changes no behaviour: both
flags default to `false` and are overridden nowhere, and `src/lib/flags.ts` is
byte-identical to `main`.

What merging does ship: the retrieval fix, the upload plan entitlement,
immediate ingestion, the pricing-copy corrections, the unmetered automatic
summaries, the `sharp` patch, and the scanner adapter.

**Gate:** CI green on the merge head. Apply migrations first if any are
outstanding — there are none in this branch (`git diff --stat main HEAD -- prisma/`
is empty).

---

## 5. Uploads, one workspace at a time

```sql
INSERT INTO "FeatureFlag" ("id","key","workspaceId","enabled","updatedAt")
VALUES (gen_random_uuid()::text, 'files', '<workspace id>', true, now());
```

Start with the Artifact Digital workspace, which already has this row. Then one
external workspace on Plus or Pro.

**Gate, per workspace:** upload a real PDF and confirm it appears; upload pure
EICAR renamed `.pdf` and confirm it is **refused** with "appears to contain
malware", leaves no row, and writes a `security.upload_rejected` audit entry.

**Note:** a Free workspace will be refused with "Attaching files to a record is
a Plus feature" — that is the plan entitlement working, not a fault.

---

## 6. Document Q&A

```sql
INSERT INTO "FeatureFlag" ("id","key","workspaceId","enabled","updatedAt")
VALUES (gen_random_uuid()::text, 'documentAi', '<workspace id>', true, now());
```

Workspace-scoped, and **Pro only** — the plan half of the gate is independent of
the flag, so a Plus workspace with the flag on still gets "Asking questions
about documents is a Pro feature".

Pricing copy stays silent until a **global** `documentAi` row exists, because
`documentQaAdvertised()` reads the flag globally. That is deliberate: the switch
that enables the capability is the one that starts promising it, so a canary
cannot accidentally advertise.

**Gate:** on a Pro workspace, upload a document, ask a question it answers and
check the citation names the right page, then ask one it does not and confirm
the answer declines.

---

## 7. General availability

A global row (`workspaceId = NULL`) for both flags. This is the step that
changes the public pricing page, because the Pro `gatedFeatures` line appears
with the flag.

Do not take this step until §5 and §6 have run on at least one external
workspace for long enough to see real documents.

---

## Rollback

| Symptom | Action |
|---|---|
| A document answer is wrong or invents something | `documentAi` → `false` for that workspace. Uploads keep working; stored documents stay readable. |
| An upload is wrongly refused as malware | Check the audit entry for the signature name. If it is a false positive, `files` → `false` for that workspace while it is investigated — do **not** unset `REQUIRE_MALWARE_SCAN`, which would accept unscanned files everywhere. |
| The scanner is down and uploads are blocked | Intended behaviour. Restart the machine. To accept the risk temporarily, set `files` → `false` for affected workspaces rather than disabling the requirement. |
| The scanner costs more than expected | `files` → `false` everywhere, then `fly machine stop`. Billing is per-second. |

Removing `MALWARE_SCANNER_URL` while `REQUIRE_MALWARE_SCAN` is `true` stops
uploads rather than passing them unscanned — the correct direction, but an
outage. Roll back by removing both together or by disabling the `files` flag.

---

## Still open, and not blocking

- **No quarantine retention.** An infected upload is deleted immediately; there
  is no copy to examine and no operator alert.
- **Nothing scans what is already stored.** Only new uploads pass through the
  scanner.
- **The privacy notice does not mention the scanner.** Self-hosting adds no
  processor to disclose, but §2 of the notice describes what happens to uploads
  and a sentence would be honest.
- **EICAR is a liveness test only.** A real payload inside a PDF stream may or
  may not be caught, depending on whether ClamAV's parser reaches it. A clean
  verdict means no known signature matched.
