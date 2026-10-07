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
| A detection is distinguishable from a validation refusal | **passed** | EICAR as `.pdf` refused at `requestUpload` with zero scans and no audit entry; EICAR as `.txt` refused by the scanner with one |
| **The hosting** | **DONE 2026-10-07** | `tiny-crm-scanner.fly.dev`, one `shared-cpu-1x`/2 GB machine in `sjc` with a 3 GB volume, $11.15/mo; all five checks pass on the deployed URL, including pure EICAR → `Eicar-Test-Signature` |
| **Production behaviour** | **NOT DONE** | nothing has run in production |

Everything in the "passed" rows ran locally or in CI. None of it exercised the
Fly machine, its TLS certificate, its volume, `freshclam` on its own timer, or
Vercel reaching across the internet to it. That is what §1–§3 are for.

---

## 1. Provision the scanner — DONE

`tiny-crm-scanner.fly.dev`. One `shared-cpu-1x` machine with 2 GB in `sjc`, a
3 GB encrypted volume with scheduled snapshots off, shared IPv4.
**$10.70 + $0.45 = $11.15/month**, inside the approved $12.

`docs/MALWARE-SCANNING.md` records what was run and the three things the plan
had wrong — no `sea` region on this account, snapshots on by default and billed,
and `fly launch` being the wrong tool.

## 2. Prove the deployed scanner — DONE

All five checks pass. The one that matters:

```
pure EICAR -> {"Status":"FOUND","Description":"Eicar-Test-Signature"}
```

Plus a readiness gap found by deploying and fixed: `/live` and `/health` were
reporting healthy for ~10s after a restart while clamd was still loading, so
Fly routed traffic at a scanner that could not scan. Both now PING clamd.

## 3. Merge — and this step DOES change customer-visible behaviour

**Merge before configuring anything in Vercel.** Verified against
`origin/main`: production has no `src/lib/malware.ts` at all, neither
`MALWARE_SCANNER_URL` nor `MALWARE_SCANNER_TOKEN` is referenced anywhere in
`src/`, and `REQUIRE_MALWARE_SCAN` is read only inside the old
`scanForMalware` stub — which is **called from nowhere**. So all three
variables are no-ops in production today. Setting them first would produce a
redeploy that changes nothing and a configuration that looks live and is not.

An earlier version of this plan had configuration at step 3 and merge at step
4. That order was wrong.

### What merging changes for customers

Both flags stay `false`, so nothing about uploads or document Q&A changes. But
it is **not** a behaviour-free merge, and two of these are immediately visible:

| Change | Who sees it |
|---|---|
| **Automatic summaries and the daily brief switch to the built-in engine.** Record pages and the home brief become the structured version instead of model-written prose. | every account, immediately |
| **The AI usage meter stops moving on page views.** Only explicit actions — regenerate, Tiny AI chat, document questions, entity extraction — spend the allowance. | every account |
| **Billing page allowance line follows the usage period.** During October it reads 25 for Free rather than 10, matching the meter beside it. | every account on the billing page |
| **"Companys" and "Opportunitys" become "companies" and "opportunities".** | every account on the billing page |
| Uploads become plan-gated (Plus and above) | nobody yet — `files` is off |
| Retrieval fixes, immediate ingestion, the scanner adapter | nobody yet — both flags off |
| `sharp` patched past CVE-2026-96889 | nobody; it is a build-time dependency |

The first two are the ones to be deliberate about. Record summaries will read
differently — more structured, less prose — and that is the intended trade for
not charging customers' allowances for pages they merely opened. If you would
rather keep model-written summaries on page load, say so before merging; it is
a one-line change at the call site.

**Gate:** CI green on the merge head. No migrations — `git diff --stat main HEAD -- prisma/`
is empty.

---

## 4. Configure the scanner in production

Now the variables mean something. Vercel → Project → Settings → Environment
Variables, **Production only**, using the secret field:

| Variable | Value |
|---|---|
| `MALWARE_SCANNER_URL` | `https://tiny-crm-scanner.fly.dev/scan` |
| `MALWARE_SCANNER_TOKEN` | the same value you set as Fly's `SCANNER_TOKEN` |

Redeploy. **Both**, not just the URL — the gateway returns 401 without the
token and the adapter treats a 401 as no verdict, so a URL on its own would
refuse every upload once step 5 is done.

Then, as a separate change:

| Variable | Value |
|---|---|
| `REQUIRE_MALWARE_SCAN` | `true` |

Redeploy again.

**The order within this step matters.** `REQUIRE_MALWARE_SCAN=true` without
`MALWARE_SCANNER_URL` is refused at boot by the configuration gate in
`src/lib/env.ts` — deliberately, so a deployment that believes it scans cannot
start without a scanner. Setting all three at once works; setting the
requirement first does not.

**Gate:** the boot line appears, and the warning
`Object storage is configured but MALWARE_SCANNER_URL is not` is gone from it.

Uploads are still off, so nothing is scanned yet.

---

## 5. Uploads, one workspace at a time

```sql
INSERT INTO "FeatureFlag" ("id","key","workspaceId","enabled","updatedAt")
VALUES (gen_random_uuid()::text, 'files', '<workspace id>', true, now());
```

Start with the Artifact Digital workspace, which already has this row. Then one
external workspace on Plus or Pro.

### The gate, and how to read a refusal

Upload a real PDF: it should appear in the project's Documents panel.

Then test the scanner **through the app** — and this is where the obvious check
is wrong:

> **Do not use EICAR renamed `.pdf`.** It is refused, but by *validation*, not
> scanning. `pdf` carries a magic-byte rule (`%PDF`) and EICAR begins
> `X5O!P%@AP`, so the file is rejected at `requestUpload` before it is even
> stored — two steps before any scan. Measured: the refusal reads *"That file's
> contents do not match its extension."*, the scanner is consulted **zero**
> times, and **no audit entry is written**.

Use **`eicar.txt`** instead. `csv`, `txt` and `md` have no magic-byte rule, so
pure EICAR as `.txt` passes validation and reaches the scanner.

| What you upload | Refused by | Message | Audit entry |
|---|---|---|---|
| pure EICAR as `eicar.txt` | **scanning** | "That file was refused because it appears to contain malware." | `security.upload_rejected`, naming the signature |
| pure EICAR as `eicar.pdf` | validation | "That file's contents do not match its extension." | **none** |
| a clean `.txt` | nothing — accepted | — | — |
| anything, while the scanner is down | scanning | "We could not scan that file. Please try again." | none |

So: **if you see "appears to contain malware" and a `security.upload_rejected`
entry, scanning is working.** If you see "contents do not match its extension",
you have tested the extension allowlist and learned nothing about the scanner.

The direct scanner check in `docs/MALWARE-SCANNING.md` §7 is separate from this
and stays separate — it bypasses the app entirely and is the one that proves
ClamAV itself is live.

**Note:** a Free workspace is refused with "Attaching files to a record is a
Plus feature". That is the plan entitlement working, not a fault.

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
