# Tiny CRM — resume checkpoint

**Written 16 October 2026.** Work is paused here deliberately. Nothing below
is in progress; everything is either done, or waiting on a decision or an
action that needs a person.

**Nothing has been published, sent, migrated or activated.**

---

## 1. Where the code is

| Branch | SHA | What it holds |
| --- | --- | --- |
| `main` | `72ece27d31101a2961c31ab93f034ae8f9191931` | What production serves. Mail-sender reporting + the mail diagnostic endpoint (PR #44, merged and deployed). |
| `feat/integrations-foundation` | `4af92338bb00320cced11f63818445ac9fc914ee` | PR #39 — the integration feature, now including multi-tenant Outlook. |
| `feat/privacy-notice-publication` | `15685e13d944f502a333978c820f467fbaf4ef4a` | PR #45 — the privacy page changes and all notice tooling. |

### Pull requests

| PR | State | Mergeable | Size |
| --- | --- | --- | --- |
| **#39** Integration foundation | open, **draft** | clean | +17692 / −115, 105 files |
| **#45** Privacy notice publication | open, **draft** | clean | +4761 / −7, 26 files |

Both are drafts on purpose, so neither can be merged by accident. **Merging
#45 is the act of publishing**: it deploys to production.

### CI

All eleven checks ran on both heads and are green:

```
success  Types, lint, schema          success  Production build
success  Test suite (SQLite)          success  Browser regressions
success  Test suite (PostgreSQL 17)   success  Backup and restore
success  Test suite (PostgreSQL 18)   success  Secret scan
success  Dependency audit             success  Vercel Preview Comments
skipped  Performance budgets   ← label-gated on pull_request, skipped on every run in this repo
```

**Known flake:** GitHub issue #43 — a `before`-hook fixture failure in
`tests/security/record-scope.test.ts`. Seen four times now, on four
independent branches, always green on re-run. Not blocking, no longer
plausibly noise.

### Production right now

`/api/health` → `ok`, database `ok`, release `72ece27d…`. `/api/ready` →
`true`. The live `/privacy` page contains **zero** mentions of Outlook or
Sentry, which is the direct confirmation that nothing has been published.

---

## 2. Public release scope

**Supported at launch: Outlook mail and Outlook Calendar, for Microsoft
work or school accounts only.**

| | Status | Why |
| --- | --- | --- |
| Outlook mail | **in scope** | |
| Outlook Calendar | **in scope** | |
| Personal Microsoft accounts (outlook.com, hotmail) | **not supported** | The authority is `organizations`, which admits work/school tenants only. `common` would admit personal accounts, whose Graph surface differs enough that "connected" would not mean the same thing; it is refused in configuration. |
| Gmail | **blocked** | Gmail read is a Google *restricted* scope: app verification plus an annual independent security assessment. |
| Google Calendar | **blocked** | Our limitation, not Google's. The import path is Microsoft Graph throughout — `sync/import.ts` consumes a `GraphMessage` and writes `provider: "outlook"`, and nothing in `sync/schedule.ts` or `sync/eligibility.ts` filters by vendor. A Google connection would have completed its handshake and then been handed to the Graph importer with a Google token: established-looking, importing nothing. |

The customer-facing copy says this explicitly — page, section markers,
banner and email all name Outlook mail and Outlook Calendar and state that
no other provider is supported. A test pins it, including that the older
generic "connect a mailbox or calendar" wording does not return.

---

## 3. Multi-tenant Outlook

**Implemented and tested in code; not proven against a real second tenant.**

`MICROSOFT_TENANT_ID` is now the authority segment itself:

- a **GUID** → pin to that one tenant (the canary configuration)
- `organizations` → any work or school tenant may connect
- `common` → refused; boot warning and the connector reports unconfigured

Widening the authority removed the single constant every token was compared
against, so **isolation moved to the connection**: the tenant that issues a
connection's first token is recorded on `Integration.providerTenantId`, and
every later token for that connection must carry the same one. A re-consent
is not a transfer. A token carrying **no** `tid` is refused in both modes —
the widening must not become "accept anything that completes the handshake".

Mutation-tested: removing the recorded-tenant comparison fails both cases;
accepting a missing `tid` fails one. Pinned mode is separately tested and
unchanged. The two modes run in separate processes, because
`MICROSOFT_TENANT_ID` is read when `env.ts` is first evaluated.

### Outstanding before this can be called publicly ready

1. **Azure app registration → multi-tenant.** Change the sign-in audience to
   *Accounts in any organizational directory*. Review whatever Microsoft
   then requires (publisher verification, and how tenants that demand admin
   consent will be handled).
2. **Production configuration**, all currently absent: `MICROSOFT_CLIENT_ID`,
   `MICROSOFT_CLIENT_SECRET`, and `MICROSOFT_TENANT_ID=organizations`.
3. **Second-tenant test — still required, and it gates "publicly ready".**
   A person in a Microsoft tenant *other* than the canary tenant must
   connect Outlook mail and Outlook Calendar and import successfully. Until
   that happens the multi-tenant path is tested but not proven. This cannot
   be done from this machine: it needs a real second tenant.
4. **Migration `…_integration_provider_tenant`** adds the nullable
   `providerTenantId` column. Present in both `prisma/migrations` and
   `prisma/migrations-postgres` and listed in `src/lib/db/migration-manifest.ts`.
   **Not applied to production.**

---

## 4. Privacy notice: not published, not sent

**No privacy change has been published. No customer notice has been sent to
anyone.** The ledger that would record a send has no rows for a production
notice; `scripts/send-notice.ts --notice=<id> --reconcile` is the
authoritative check and should be run before trusting this paragraph.

**15 October was a *proposed* send date. It passed without a send.** Do not
record it as having happened anywhere.

### The effective date must be recalculated, not reused

`INTEGRATIONS_EFFECTIVE_ON` is currently `"2026-11-16"` in `src/lib/legal.ts`
on PR #45. That value was computed from a 15 October send and **is now
wrong for any realistic send date**:

| If notice is sent | 16 November is | Verdict |
| --- | --- | --- |
| 16 Oct 2026 | 31 days later | just works, ~1 day of margin |
| 17 Oct 2026 | 30 days later | exactly the minimum, no margin |
| 20 Oct 2026 | 27 days later | **too early — must move** |
| 25 Oct 2026 | 22 days later | **too early — must move** |

The commitment runs **30 days from the day each customer is emailed**, not
from publication and not from any date in a diary. The rule to apply:

> **effective date = actual send date + 32 days**, and the constant is set
> on the day the send actually happens, not before.

Worked examples: send 20 Oct → 21 Nov. Send 25 Oct → 26 Nov. Send 1 Nov →
3 Dec.

The 2-day margin beyond the 30 exists so a send that slips by a day does not
eat into the period. It is not a target to trim.

### The notice interpretation, as reviewed

An independent read of the live texts, with every quote verified against
`origin/main`:

- Privacy § 12 commits only on **material** changes. "Materially" is
  **undefined** and **no decider is named** — deciding it is deciding our own
  case.
- The better reading is that the 30 days **delay effect**, not merely
  notification: § 12's own carve-out ("Changes required sooner by law may
  take effect sooner") is unintelligible unless delayed effect is the
  baseline, and Terms § 4 calls the policy a thing that "does not delay" tax
  collection.
- **On consent the text is silent.** There is no waiver provision in either
  document. § 12 has exactly one exception and it is legal compulsion, which
  argues against implying a second. **The decision taken was not to rely on
  an implied opt-in exception.**
- Existing vs new accounts: the texts draw **no distinction**, and the pages
  carry no version identifier at all. Any new-account carve-out is inference,
  not text.
- Terms § 5 makes the privacy notice "part of these terms"; § 11 then adds a
  cancellation right and an express delay on application — but scoped to "an
  existing subscription", so it may not engage for Free accounts while § 12
  still does.

### Approved copy decisions (unchanged)

One combined email; the Sentry correction published **with the page** as a
labelled correction describing existing processing, not future-dated;
`privacy@tinycrm.biz` as the contact; no "reply to this message". The email
text lives in **one** place: `docs/legal/PUBLICATION-PACKAGE.md` § 3.

---

## 5. Verified and closed

| What | Evidence |
| --- | --- |
| **Production mail delivery** | `MAIL_FROM` was empty while a provider was configured, so every message was sent from `no-reply@localhost` and refused — password reset, verification, invitations and sign-in alerts all failing silently. Fixed by configuration. Confirmed by a real delivery: one test message through `/api/diagnostics/mail` returned HTTP 200 and **arrived** at privacy@tinycrm.biz from `Tiny CRM <no-reply@tinycrm.biz>`. The sender is now on the boot line of every release. |
| **Cron after the `CRON_SECRET` rotation** | `/api/cron/jobs` returned **HTTP 200 at 18:00:49 and again at 18:30:49 UTC**, both after the rotation. Two consecutive scheduled runs, so automations, scheduled workspace deletions and retention sweeps are running. A stale secret would have given 401. |
| **Restricted review role** | `tinycrm_review` passed **all 53 checks** in `scripts/verify-review-role.mjs`: not superuser, no `BYPASSRLS`, **not a member of `neon_superuser`**, seven permitted `User` columns readable, eighteen forbidden columns refused (including `passwordHash` and every MFA/auth field), eighteen tables unreadable, four write attempts refused. |
| **Recipient audience** | **8 included / 20 excluded / 0 ambiguous**, of 28 accounts. |

### Where the snapshot lives

`recipient-snapshot.json` in the repository root. **Gitignored and never
committed.** It holds truncated SHA-256 hashes and masked addresses — no
email addresses and no credentials. Two of the eight are internal accounts,
so customer-facing reach is six.

Re-run before any send and compare, rather than trusting it:

```
node scripts/review-recipients.mjs --compare recipient-snapshot.json
```

An unreadable file exits non-zero rather than reporting "no changes".

**No credentials of any kind are recorded in this document, and none should
be added to it.** Every operator script takes its connection string and
tokens by hidden prompt.

---

## 6. Outstanding: owner-password rotation and cleanup

The production Neon `neondb_owner` password was **exposed and has been
rotated** by the owner. Production health and readiness were confirmed `ok`
afterwards, on release `72ece27d…`.

Local cleanup was verified clean: `~/.zsh_history`, all ten
`~/.zsh_sessions/` files, bash, psql and node REPL history searched for
connection-string shapes and for Neon-specific markers (`neondb_owner`,
`npg_`, `ep-`, `@ep-`) — **zero matches**. No iTerm2 directory, so
Terminal.app scrollback was in-memory and went with the window. With zsh's
defaults history is written at shell exit, so the command was most likely
never flushed. `scripts/scrub-shell-history.zsh` remains available and
matches credential *shapes*, never a literal secret.

**Still unverified, and worth closing:**

1. **Neon connection monitoring** — whether anything unexpected connected
   while the old password was live. An owner credential bypasses RLS, so
   this deserves a look rather than an assumption. Neon Console →
   Monitoring.
2. **Which role production's `DATABASE_URL` uses.** Inferred to be
   `tinycrm_app` from the boot log line `role: tinycrm_app`; the value
   itself has never been read. Worth confirming in Vercel so that the
   rotation is known to have been irrelevant to the running app rather than
   assumed so.

---

## 7. Next three actions

**1. Decide and record the real send date, then recalculate the effective
date from it.** *Needs you.* Set `INTEGRATIONS_EFFECTIVE_ON` to send date +
32 days on PR #45. Nothing else should be scheduled until this is a real
date rather than a leftover one.

**2. Switch the Azure app registration to multi-tenant and set the three
Microsoft variables in production.** *Needs you* — I have no access to the
Azure portal or to production secrets. Then the second-tenant connect test,
which also needs a person in another tenant. This is very likely the longest
pole, and it runs in parallel with the notice period rather than after it.

**3. Run the publication sequence, in order, on the agreed day.** *Needs
you* at every step; I can drive the checks and read the results.

   1. `node scripts/review-recipients.mjs --compare recipient-snapshot.json`
      — show any change from the approved eight.
   2. `npx tsx scripts/preflight-notice.ts --audience=recipient-snapshot.json
      --from='Tiny CRM <no-reply@tinycrm.biz>'` — prompts hidden; must report
      production database, `http` adapter, 8 matched, 0 missing, 0 sent.
      Refuses a local database, a sink adapter or an audience mismatch.
   3. Merge PR #45 — **this publishes the page.**
   4. Send, reconcile from the Resend dashboard, and read it again the next
      day.

**Activation stays separately gated after all of that**: it requires the
notice window elapsed for every recipient **and** the published effective
date reached. Passing the delivery checks early does not bring the date
forward — `activationPermitted()` enforces both and there is a test for the
case where every check is green two days before the date.

---

## 8. Standing constraints

Do not merge, deploy, apply production migrations, send customer messages,
or enable integration flags without explicit approval. Secrets go through
hidden prompts or Vercel's secret fields — never chat, source control,
command arguments or logs. Do not rotate `AUTH_SECRET`. Do not delete
accounts.
