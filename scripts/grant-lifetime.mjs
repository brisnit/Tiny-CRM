#!/usr/bin/env node
/**
 * Gives ONE named account the Lifetime entitlement, as a reviewed operator
 * action rather than a dropdown.
 *
 *   node scripts/grant-lifetime.mjs            # inspect only — the default
 *   node scripts/grant-lifetime.mjs --apply
 *   node scripts/grant-lifetime.mjs --revert --apply
 *
 * ## Why this is a script and not the admin panel
 *
 * The admin panel cannot do this, deliberately. `GRANTABLE_PLANS` in
 * src/lib/plans.ts is `["plus", "pro"]`, and the comment above it says why:
 *
 *   > Lifetime is deliberately absent: it carries unlimited ceilings that no
 *   > purchasable plan offers, and handing it out from an admin panel is not a
 *   > decision to make through a dropdown.
 *
 * This script does not widen that control. It does not add Lifetime to
 * `GRANTABLE_PLANS`, does not touch the panel, and cannot be pointed at an
 * account it was not written for: the user id AND the email must both match
 * the constants below, or it refuses. Changing who it affects means editing
 * this file, which is a reviewable diff — which is the point.
 *
 * ## What "the same entitlement my owner account has" means
 *
 * `User.plan = 'legacy_lifetime'`. That is the canonical stored value after
 * scripts/migrate-legacy-plans.mjs moved the pre-Stripe `lifetime` rows onto
 * the legacy plan ids; `PRE_STRIPE_PLAN_ALIASES` still resolves a stray
 * `lifetime` to the same place. `legacy_lifetime` is rank 4, the highest in
 * `PLAN_RANK`, so nothing can be a higher entitlement and nothing is lost by
 * moving to it.
 *
 * ## What it does NOT do
 *
 *   - **No platform-admin access.** `PlatformAdmin` is a separate table and is
 *     never touched here. Lifetime is a customer entitlement.
 *   - **No feature-flag bypass.** A flag that is off stays off; entitlement and
 *     rollout are separate gates (see src/lib/integrations/gate.ts).
 *   - **No Stripe call.** No charge, no refund, no subscription is created,
 *     changed or cancelled. This writes one column in one row.
 *   - **No change to `planStatus`, `planRenewsAt` or `billingCustomerId`**, for
 *     the same reason migrate-legacy-plans.mjs leaves them: they describe the
 *     billing relationship, which is not what is being changed.
 *
 * ## The durability problem, which has to be settled before --apply
 *
 * `applyPlanChange` in src/lib/entitlements.ts writes `plan` unconditionally,
 * and the Stripe webhook calls it on every subscription event with whatever
 * plan the price maps to. There is **no legacy guard on that path**. So if
 * this account has any Stripe subscription — active, trialing, past due, or
 * cancelled but still emitting events — the next webhook silently overwrites
 * Lifetime with the plan Stripe believes in, and nobody is told.
 *
 * The inspection below reports the subscription state for exactly this reason.
 * If it finds one, STOP: a durable answer needs a legacy guard in
 * `applyPlanChange`, which is a code change and a deploy, not this script.
 *
 * Safety: dry run by default, credential read with echo off, one transaction,
 * an AuditLog row written with the change, and `--revert` restores the value
 * recorded before.
 *
 * ## RUN RECORD — this has already been applied. Do not run it again.
 *
 * Applied against production on 2026-10-13 for the account named in the
 * constants below, authorised by the owner. Verified from the database
 * afterwards: the plan moved to `legacy_lifetime`, the account has no Stripe
 * billing customer, and `PlatformAdmin` remained empty for it.
 *
 * Re-running the forward path is a no-op by construction — it exits when the
 * account already holds `legacy_lifetime` — but there is no reason to, and an
 * operator script that gets run speculatively is one that eventually gets run
 * against the wrong thing.
 *
 * The file is kept because the change should be reviewable after the fact:
 * what was run, against whom, with what safeguards, and how to undo it. A
 * production entitlement change that exists only in one person's terminal
 * history is not auditable.
 *
 * ## Rollback
 *
 *   node scripts/grant-lifetime.mjs --revert --from=<previous plan> --apply
 *
 * `<previous plan>` is the value the forward run printed under BEFORE, and is
 * also recorded in the `AuditLog` row it wrote:
 *
 *   SELECT "summary", "metadata" FROM "AuditLog"
 *    WHERE "entityId" = 'cmv744ayl000506kuwsi016r5'
 *      AND "action" = 'admin.plan_changed'
 *    ORDER BY "createdAt" DESC LIMIT 1;
 *
 * The `metadata` JSON carries `{"from": …, "to": …}`. Read it from there
 * rather than from memory — this script will not guess it, and `--revert`
 * without `--from` is refused.
 *
 * Rolling back is a plain plan change and touches nothing else: no Stripe
 * call, no subscription, no charge, no refund, and `PlatformAdmin` is not
 * involved in either direction.
 */

import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";

import { promptHidden } from "./lib/prompt-hidden.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

/** Who this script is for. Both must match, or it refuses. */
const TARGET_USER_ID = "cmv744ayl000506kuwsi016r5";
const TARGET_EMAIL = "jason@financesatwork.com";

/** The canonical Lifetime storage value. */
const LIFETIME = "legacy_lifetime";

/** Recorded on the audit row, and the reason this action exists. */
const AUDIT_REASON = "Owner-authorized complimentary Lifetime access";

/** Identical to the other production scripts. A host is not a secret. */
const PRODUCTION_FINGERPRINTS = new Map([
  ["18155d6dda02", "production, POOLED endpoint (what the app uses)"],
  ["005bee3e08cc", "production, DIRECT endpoint"],
]);

function fingerprint(url) {
  const parsed = new URL(url);
  return createHash("sha256")
    .update(`${parsed.hostname}/${parsed.pathname.replace(/^\//, "")}`)
    .digest("hex")
    .slice(0, 12);
}

const scrub = (t) => String(t).replace(/postgres(ql)?:\/\/\S+/g, "[connection string redacted]");

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((done) => {
    let answered = false;
    const finish = (v) => { if (!answered) { answered = true; rl.close(); done(v); } };
    rl.question(question, (a) => finish(a.trim()));
    rl.on("close", () => finish(""));
  });
}

async function main() {
  const apply = process.argv.includes("--apply");
  const revert = process.argv.includes("--revert");

  console.log(`\nLifetime entitlement — ${apply ? (revert ? "REVERT" : "APPLY") : "inspect only"}`);
  console.log("=".repeat(72));
  console.log(`  target user   ${TARGET_USER_ID}`);
  console.log(`  target email  ${TARGET_EMAIL}`);
  console.log(`  entitlement   plan = '${LIFETIME}'  (rank 4, the highest)`);

  const url = await promptHidden("Owner/direct connection string (input hidden): ");
  let fp;
  try { fp = fingerprint(url); } catch { throw new Error("That is not a parseable connection string."); }
  const match = PRODUCTION_FINGERPRINTS.get(fp);
  console.log(`\n  fingerprint   ${fp}`);
  if (!match) {
    console.error("\nREFUSED. Not a known production database. Nothing was read or written.\n");
    process.exit(1);
  }
  console.log(`  identified    ${match}`);

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();
  try {
    // ---- Identity: the id and the email must agree -----------------------
    const byId = await client.query(
      `SELECT "id", "email", "name", "plan", "planStatus", "planRenewsAt",
              "billingCustomerId", "deactivatedAt", "createdAt"
         FROM "User" WHERE "id" = $1`,
      [TARGET_USER_ID],
    );
    if (byId.rowCount === 0) {
      console.error(`\nREFUSED. No user with id ${TARGET_USER_ID}. Nothing was changed.\n`);
      process.exit(1);
    }
    const user = byId.rows[0];
    if (user.email?.toLowerCase() !== TARGET_EMAIL.toLowerCase()) {
      console.error(
        `\nREFUSED. That id belongs to a different account than the email given.\n` +
          `  id ${TARGET_USER_ID} is ${user.email}\n` +
          `  the email supplied was ${TARGET_EMAIL}\n\n` +
          `  Both must match. Nothing was read further and nothing was changed.\n`,
      );
      process.exit(1);
    }
    console.log(`\n  IDENTITY      id and email agree — ${user.email}`);

    // ---- What is there now ------------------------------------------------
    const grants = await client.query(
      `SELECT "id", "plan", "reason", "grantedAt", "expiresAt", "revokedAt"
         FROM "PlanGrant" WHERE "userId" = $1 ORDER BY "grantedAt" DESC`,
      [TARGET_USER_ID],
    );
    const admin = await client.query(
      `SELECT count(*)::int AS n FROM "PlatformAdmin" WHERE "userId" = $1`,
      [TARGET_USER_ID],
    );
    const owned = await client.query(
      `SELECT count(*)::int AS n FROM "Workspace" WHERE "ownerId" = $1`,
      [TARGET_USER_ID],
    );

    console.log("\n  BEFORE");
    console.log(`    name                ${user.name ?? "—"}`);
    console.log(`    plan                ${user.plan}`);
    console.log(`    planStatus          ${user.planStatus ?? "—"}`);
    console.log(`    planRenewsAt        ${user.planRenewsAt?.toISOString() ?? "—"}`);
    console.log(`    billingCustomerId   ${user.billingCustomerId ?? "none — never transacted"}`);
    console.log(`    suspended           ${user.deactivatedAt ? "YES" : "no"}`);
    console.log(`    workspaces owned    ${owned.rows[0].n}`);
    console.log(`    platform admin      ${admin.rows[0].n > 0 ? "YES" : "no"}  (unchanged by this script)`);
    console.log(`    plan grants         ${grants.rowCount}`);
    for (const g of grants.rows) {
      const state = g.revokedAt ? "revoked" : g.expiresAt && g.expiresAt < new Date() ? "expired" : "active";
      console.log(`      - ${g.plan} (${state}) ${g.reason ?? ""}`);
    }

    // ---- The durability question -----------------------------------------
    console.log("\n  WEBHOOK DURABILITY");
    if (user.billingCustomerId) {
      console.log(`    FAIL  this account has a Stripe customer (${user.billingCustomerId}).`);
      console.log(`          applyPlanChange writes "plan" unconditionally and the Stripe`);
      console.log(`          webhook calls it on every subscription event. There is no`);
      console.log(`          legacy guard on that path, so the next event for this customer`);
      console.log(`          would silently overwrite Lifetime with whatever the price maps`);
      console.log(`          to, and nobody would be told.`);
      console.log(`\n          Check the subscription state in Stripe before deciding. A`);
      console.log(`          durable answer needs a legacy guard in applyPlanChange — a`);
      console.log(`          code change and a deploy, not this script.`);
    } else {
      console.log(`    ok    no Stripe customer, so no subscription webhook can fire for`);
      console.log(`          this account and nothing will overwrite the stored plan.`);
      console.log(`          If they later subscribe, the webhook WILL overwrite it —`);
      console.log(`          the legacy guard is still worth having.`);
    }

    // ---- Entitlement direction -------------------------------------------
    const RANK = { free: 0, plus: 1, pro: 2, legacy_pro: 3, legacy_lifetime: 4 };
    const ALIASES = { lifetime: "legacy_lifetime" };
    const current = ALIASES[user.plan] ?? user.plan;
    const currentRank = RANK[current];
    if (currentRank === undefined) {
      console.log(`\n  REFUSING: stored plan "${user.plan}" is not a plan this script knows.`);
      process.exit(1);
    }
    console.log("\n  AFTER");
    if (revert) {
      console.log(`    --revert restores the value recorded in the audit row written by`);
      console.log(`    the forward run. Supply it with --from=<plan> after reading it.`);
    } else if (currentRank > RANK[LIFETIME]) {
      console.log(`    REFUSED — "${current}" already outranks ${LIFETIME}. A higher`);
      console.log(`    entitlement is never reduced. Nothing to do.`);
      process.exit(1);
    } else if (current === LIFETIME) {
      console.log(`    No change — already ${LIFETIME}.`);
      process.exit(0);
    } else {
      console.log(`    plan                ${user.plan}  ->  ${LIFETIME}`);
      console.log(`    planStatus          ${user.planStatus ?? "—"}  (unchanged)`);
      console.log(`    planRenewsAt        ${user.planRenewsAt?.toISOString() ?? "—"}  (unchanged)`);
      console.log(`    billingCustomerId   ${user.billingCustomerId ?? "none"}  (unchanged)`);
      console.log(`    everything else     unchanged`);
    }

    console.log("\n  ROLLBACK");
    console.log(`    node scripts/grant-lifetime.mjs --revert --from=${user.plan} --apply`);
    console.log(`    restores plan = '${user.plan}'. Record that value now; it is also`);
    console.log(`    written into the audit row's metadata by the forward run.`);

    console.log("\n  AUDIT ROW THAT WILL BE WRITTEN");
    console.log(`    action      admin.plan_changed`);
    console.log(`    entityType  user`);
    console.log(`    entityId    ${TARGET_USER_ID}`);
    console.log(`    summary     ${AUDIT_REASON}: ${user.plan} -> ${LIFETIME} for ${user.email}`);
    console.log(`    metadata    {"from":"${user.plan}","to":"${LIFETIME}","reason":"${AUDIT_REASON}","via":"scripts/grant-lifetime.mjs"}`);

    if (!apply) {
      console.log("\n  Inspect only. Nothing was changed. Re-run with --apply.\n");
      return;
    }

    if (user.billingCustomerId && !process.argv.includes("--i-have-checked-stripe")) {
      console.error(
        `\nREFUSED. This account has a Stripe customer, so a future webhook can\n` +
          `  silently undo this. Settle that first — see WEBHOOK DURABILITY above.\n` +
          `  If the subscription state has been checked and this is still wanted,\n` +
          `  re-run with --i-have-checked-stripe. Nothing was changed.\n`,
      );
      process.exit(1);
    }

    const answer = await ask(`\n  Type the user id to proceed: `);
    if (answer !== TARGET_USER_ID) {
      console.log("\n  Aborted. Nothing was changed.\n");
      return;
    }

    const from = revert
      ? (process.argv.find((a) => a.startsWith("--from="))?.slice(7) ?? null)
      : user.plan;
    if (revert && !from) {
      console.error("\nREFUSED. --revert needs --from=<plan>. Nothing was changed.\n");
      process.exit(1);
    }
    const to = revert ? from : LIFETIME;

    // One transaction: the plan and its audit row move together or not at all.
    await client.query("BEGIN");
    try {
      const updated = await client.query(
        `UPDATE "User" SET "plan" = $1 WHERE "id" = $2 AND "email" = $3 AND "plan" = $4`,
        [to, TARGET_USER_ID, TARGET_EMAIL, user.plan],
      );
      if (updated.rowCount !== 1) {
        throw new Error(
          `expected to update exactly 1 row, updated ${updated.rowCount} — the account ` +
            `changed between the read and the write. Nothing has been committed.`,
        );
      }
      await client.query(
        `INSERT INTO "AuditLog" ("id","workspaceId","actorId","actorEmail","action",
                                 "entityType","entityId","summary","metadata","createdAt")
         VALUES (gen_random_uuid()::text, NULL, NULL, $1, $2, 'user', $3, $4, $5, now())`,
        [
          "operator:scripts/grant-lifetime.mjs",
          revert ? "admin.plan_change_reverted" : "admin.plan_changed",
          TARGET_USER_ID,
          `${AUDIT_REASON}: ${user.plan} -> ${to} for ${user.email}`,
          JSON.stringify({ from: user.plan, to, reason: AUDIT_REASON, via: "scripts/grant-lifetime.mjs" }),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    // Read back rather than trust the exit code.
    const after = await client.query(
      `SELECT "plan","planStatus","planRenewsAt","billingCustomerId" FROM "User" WHERE "id" = $1`,
      [TARGET_USER_ID],
    );
    const a = after.rows[0];
    console.log("\n  VERIFIED FROM THE DATABASE");
    console.log(`    plan                ${a.plan}  ${a.plan === to ? "ok" : "MISMATCH"}`);
    console.log(`    planStatus          ${a.planStatus ?? "—"}`);
    console.log(`    planRenewsAt        ${a.planRenewsAt?.toISOString() ?? "—"}`);
    console.log(`    billingCustomerId   ${a.billingCustomerId ?? "none"}`);
    const adminAfter = await client.query(
      `SELECT count(*)::int AS n FROM "PlatformAdmin" WHERE "userId" = $1`,
      [TARGET_USER_ID],
    );
    console.log(`    platform admin      ${adminAfter.rows[0].n > 0 ? "YES" : "no"}  (unchanged)`);
    console.log(`\n  Done. Rollback: --revert --from=${user.plan} --apply\n`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\n${scrub(error?.message ?? error)}\n`);
  process.exit(1);
});
