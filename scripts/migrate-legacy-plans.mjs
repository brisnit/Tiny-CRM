#!/usr/bin/env node
/**
 * Moves pre-Stripe plan values onto the legacy plan ids, preserving entitlements
 * exactly.
 *
 *   pro      -> legacy_pro        (unlimited records, 1,000 AI requests, 5 seats)
 *   lifetime -> legacy_lifetime   (unlimited records, 2,000 AI requests, 5 seats)
 *
 * ## Why this has to run *before* the new plans ship
 *
 * The new tiers reuse the name `pro` with finite ceilings — 5,000 contacts rather
 * than no limit. An account still storing `plan = 'pro'` after the deploy would
 * resolve to the *new* Pro and could be over its limits on the first write.
 * Renaming a plan does not preserve entitlements, which is the whole reason
 * `legacy_pro` exists.
 *
 * So the order is: run this, confirm the counts, then deploy. That is the same
 * database-ahead-of-code sequencing the Document Intelligence release used, and
 * for the same reason — the safe direction is a database that already understands
 * what the next deployment will ask of it.
 *
 * ## Reversible
 *
 * `--revert` puts the old values back. The mapping is one-to-one with no data
 * loss in either direction, so a rollback of the deploy does not need a restore.
 *
 * ## Safety
 *
 *   - Dry run by default. `--apply` is required to write.
 *   - The credential is read from the terminal with echo off.
 *   - One transaction. Either every row moves or none does.
 *   - Only the `plan` column is touched, and only for rows holding exactly the
 *     two legacy values. `planStatus`, `planRenewsAt` and `billingCustomerId` are
 *     left alone.
 *
 * Usage:
 *   node scripts/migrate-legacy-plans.mjs            # dry run
 *   node scripts/migrate-legacy-plans.mjs --apply
 *   node scripts/migrate-legacy-plans.mjs --revert --apply
 */

import { Client } from "pg";
import { promptHidden } from "./lib/prompt-hidden.mjs";

const FORWARD = [
  ["pro", "legacy_pro"],
  ["lifetime", "legacy_lifetime"],
];


async function main() {
  const apply = process.argv.includes("--apply");
  const revert = process.argv.includes("--revert");
  const pairs = revert ? FORWARD.map(([a, b]) => [b, a]) : FORWARD;

  const connectionString = await promptHidden(
    "Production connection string (the application role; input hidden): ",
  );

  const host = (() => {
    try {
      return new URL(connectionString).hostname;
    } catch {
      return "";
    }
  })();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";

  const client = new Client({
    connectionString,
    ssl: loopback ? false : { rejectUnauthorized: true },
    statement_timeout: 30_000,
  });

  await client.connect();
  let open = false;

  try {
    // Even the dry run opens a transaction, so the counts it reports are the
    // counts a write in the same transaction would have seen.
    await client.query("BEGIN");
    open = true;

    const who = await client.query("SELECT current_user AS role, current_database() AS db");
    console.log(`\nConnected as ${who.rows[0].role} to ${who.rows[0].db}`);
    console.log(`Direction: ${revert ? "REVERT (legacy ids -> original values)" : "FORWARD (original values -> legacy ids)"}`);
    console.log(`Mode: ${apply ? "APPLY" : "DRY RUN (rehearsed, then rolled back)"}\n`);

    let total = 0;
    for (const [from, to] of pairs) {
      const affected = await client.query(
        `SELECT id, email FROM "User" WHERE plan = $1 ORDER BY "createdAt"`,
        [from],
      );
      console.log(`  ${from} -> ${to}: ${affected.rows.length} account(s)`);
      for (const row of affected.rows) console.log(`      ${row.email}`);
      total += affected.rows.length;

      // The write happens in both modes, inside the transaction. A dry run that
      // only *counts* reports the state before the migration, so its own
      // post-migration checks would run against pre-migration data — the first
      // version of this script failed its unknown-value check on exactly the
      // value it was about to fix. Writing and rolling back makes the dry run a
      // real rehearsal: every constraint, trigger and check fires.
      if (affected.rows.length > 0) {
        const updated = await client.query(`UPDATE "User" SET plan = $1 WHERE plan = $2`, [to, from]);
        if (updated.rowCount !== affected.rows.length) {
          throw new Error(
            `Expected to update ${affected.rows.length} rows for ${from}, updated ${updated.rowCount}. Rolling back.`,
          );
        }
      }
    }

    // Nothing should be left holding a value the application no longer knows.
    const stragglers = await client.query(
      `SELECT plan, count(*)::int AS n FROM "User" GROUP BY plan ORDER BY plan`,
    );
    console.log(`\n  ${apply ? "resulting" : "projected"} plan distribution:`);
    for (const r of stragglers.rows) console.log(`      ${String(r.plan).padEnd(18)} ${r.n}`);

    // Checked in the forward direction only.
    //
    // Going forward, a value the new code does not recognise is a real hazard:
    // planFor() falls back to Free, which for a paying account is a silent loss
    // of access. Going backwards, the old values are the *intended* end state —
    // the point of a revert is to return the database to something the previous
    // deployment understands — so applying the new code's vocabulary there would
    // block every legitimate rollback. The first version of this script did
    // exactly that and refused its own revert.
    if (!revert) {
      const known = new Set(["free", "plus", "pro", "legacy_pro", "legacy_lifetime"]);
      const unknown = stragglers.rows.filter((r) => !known.has(r.plan));
      if (unknown.length > 0) {
        throw new Error(
          `Plan values the application does not recognise: ${unknown.map((r) => `${r.plan} (${r.n})`).join(", ")}. ` +
            "These resolve to Free at runtime. Resolve them before deploying.",
        );
      }
    }

    if (apply) {
      await client.query("COMMIT");
      open = false;
      console.log(`\nAPPLIED: ${total} account(s) moved.\n`);
    } else {
      await client.query("ROLLBACK");
      open = false;
      console.log(`\nDRY RUN complete: ${total} account(s) would move. Re-run with --apply.\n`);
    }
  } catch (error) {
    if (open) await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, "postgres://[redacted]");
  console.error(`\nMigration failed: ${message}\n`);
  process.exitCode = 1;
});
