# Rotating `AUTH_SECRET` — break-glass only

**Do not rotate `AUTH_SECRET` as routine hygiene. It is not a key with a
rotation schedule; it is a key with a recovery plan.**

One environment variable derives three independent key spaces. Rotating it
changes all three at once, and only one of the three recovers by itself.

| What it derives | Where | What rotation does |
|---|---|---|
| Session signing | `src/auth.ts` → `secret: env.authSecret` | Every session is invalidated. Everyone is signed out. |
| TOTP secret encryption | `src/lib/auth/mfa.ts` → `scryptSync(env.authSecret, "tiny-crm/mfa/v1", 32)` | **Every enrolled two-factor secret becomes undecryptable.** |
| OAuth credential encryption | `src/lib/crypto.ts` → `scryptSync(env.authSecret, "tiny-crm/integration-credentials/v1", 32)` | Every stored mailbox and calendar token becomes undecryptable. |

The purpose-naming salts keep the three key spaces separate from each other —
a ciphertext from one cannot be decrypted as another — but they all take the
same input, so they all die together.

## The one that is actually dangerous

**Two-factor lockout.** `verifyTotp` catches the decryption failure and
returns `{ ok: false, reason: "unavailable" }`. The user cannot complete
sign-in. There is no self-service path out of this:

- They cannot re-enrol, because re-enrolling requires being signed in.
- Recovery codes do not help if they are derived from the same secret —
  check before relying on them.
- The account is not locked, suspended or broken in any visible way. From
  the user's side their authenticator app simply stops being accepted, which
  reads like their phone is wrong, not like we changed something.

Every MFA-enrolled account needs an operator to disable their second factor
before they can sign in again, and each of those is a support conversation in
which you have to establish who you are talking to **without** the second
factor you had just invalidated. That is the real cost, and it scales with the
number of security-conscious customers.

## The one that recovers by itself

**Mailbox and calendar connections.** `accessTokenFor` catches the decryption
failure, sets the connection to `reauth_required`, destroys the unreadable
credential, and records a message the customer can act on. The sync chain
stands down rather than retrying something a retry cannot fix, and Settings
shows **"Reconnect needed"** with a working Connect button. The customer
reconnects; nothing already imported is lost.

This is the only one of the three that is genuinely survivable without
operator involvement, and it is the one I previously — and wrongly —
generalised from when calling a rotation "survivable".

## When to rotate anyway

Rotate when the secret has, or may have, leaked: a commit, a log, a
screenshot, a support ticket, a compromised machine that had it in an
environment file. An attacker holding `AUTH_SECRET` can mint a session for any
account, which is worse than any amount of lockout you control and schedule.

**Do not** rotate because it feels overdue, because a compliance checklist has
a "rotate secrets quarterly" line, or as a precaution while investigating
something unrelated. There is no partial version of this operation.

## If you must: the order

1. **Decide the window.** Everyone is signed out mid-session. Pick a time when
   that is least damaging and say so in advance if you can.
2. **Count the exposure first**, before touching anything:

   ```sql
   SELECT count(*) FROM "MfaCredential";                   -- accounts to unlock
   SELECT count(*) FROM "Integration" WHERE status = 'connected';  -- reconnections to ask for
   ```

   The first number is how many support conversations you have just scheduled.
   If it is larger than you can handle in a day, plan the support load before
   the rotation, not after.
3. **Have an out-of-band identity check ready** for the MFA conversations. You
   are about to verify people's identity without the factor you invalidated.
4. **Generate and set** the new value in Vercel's secret field —
   `openssl rand -base64 32`. Never in a command argument, a file in the
   repository, or chat.
5. **Deploy.** The value is read at boot.
6. **Expect the integrations to self-report.** Connections move to
   `reauth_required` the first time a sync runs, which is within thirty
   minutes of the cron. They do not need chasing.
7. **Work the MFA list.** Disable the second factor per account after
   verifying identity out of band; the customer re-enrols on next sign-in.

## What not to do

- **Do not** try to re-encrypt the existing ciphertexts with the new key.
  There is nothing to re-encrypt *from* — the old key is what you just
  destroyed. If the old value still exists somewhere, the rotation has not
  achieved anything anyway.
- **Do not** rotate to "test" the recovery path. The decryption-failure
  behaviour for integrations is covered by
  `tests/security/integration-sync-worker.test.ts`, which corrupts a
  credential deliberately and asserts the reconnect prompt, the stand-down and
  that nothing already imported is touched. Test there, not in production.
- **Do not** describe this to a customer as a security improvement. It is a
  containment action, and the honest framing is that their session ended
  because we invalidated it.

## If separating the keys ever becomes worthwhile

The coupling is the problem, not the rotation. Deriving MFA and integration
keys from their own environment variables — falling back to `AUTH_SECRET`
when unset, so nothing breaks on the day it ships — would let a session-secret
rotation happen without touching either. It is not urgent while rotation is
genuinely rare, and it introduces two more secrets to manage, so it is written
down here as an option rather than proposed as work.
