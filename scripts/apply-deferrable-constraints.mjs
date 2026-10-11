#!/usr/bin/env node
/**
 * Makes every foreign key in production DEFERRABLE again.
 *
 *   node scripts/apply-deferrable-constraints.mjs            # inspect only
 *   node scripts/apply-deferrable-constraints.mjs --apply
 *
 * ## Why this exists
 *
 * `prisma/postgres/003_deferrable_constraints.sql` is not part of the migration
 * history — SQLite has no equivalent and Prisma cannot express it — so it is
 * applied separately, and it only affects the foreign keys that exist **at the
 * moment it runs**. Any later migration that adds a foreign key therefore adds
 * a *non-deferrable* one, and the deployment gate refuses the next production
 * build: a logical restore of a schema with a circular foreign key is
 * impossible without deferrable constraints, which is a property worth failing
 * a deploy over.
 *
 * That is exactly what happened with the owner-admin panel release. The
 * migration added three foreign keys — two on `PlanGrant`, one on
 * `PlatformAdmin` — and the procedure applied only the new policy file, so the
 * gate blocked the build with the migration already applied. Nothing was
 * broken and nothing was exposed; the release simply could not ship until the
 * constraints were fixed.
 *
 * `scripts/migrate-admin-panel.mjs` now applies 003 itself, so the ordinary
 * path no longer leaves this behind. This script is the repair for a database
 * that is already in that state, and the general answer for any future
 * migration that adds a foreign key.
 *
 * 003 is generic and idempotent: it alters every non-deferrable foreign key in
 * `public` and touches nothing else. It changes no data, no row, no plan, no
 * policy and no entitlement — only whether a constraint *may* be deferred
 * inside an explicit transaction. `DEFERRABLE INITIALLY IMMEDIATE` leaves
 * normal operation identical.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import { promptHidden } from "./lib/prompt-hidden.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const ROOT = resolve(import.meta.dirname, "..");
const SQL_FILE = "prisma/postgres/003_deferrable_constraints.sql";

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

/** The gate's own question, asked the same way: which foreign keys cannot defer. */
async function nonDeferrable(client) {
  const { rows } = await client.query(
    `SELECT con.conrelid::regclass::text AS tbl, con.conname AS name
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE con.contype = 'f'
        AND rel.relnamespace = 'public'::regnamespace
        AND NOT con.condeferrable
      ORDER BY 1, 2`,
  );
  return rows;
}

async function main() {
  const apply = process.argv.includes("--apply");

  console.log(`\nDeferrable foreign keys — ${apply ? "APPLY" : "inspect only"}`);
  console.log("=".repeat(70));
  console.log(`  sql file  ${SQL_FILE}`);

  const url = await promptHidden("Owner/direct connection string (input hidden): ");
  let fp;
  try {
    fp = fingerprint(url);
  } catch {
    throw new Error("That is not a parseable connection string.");
  }
  const match = PRODUCTION_FINGERPRINTS.get(fp);
  console.log(`\n  fingerprint  ${fp}`);
  if (!match) {
    console.error("\nREFUSED. Not a known production database. Nothing was read or written.\n");
    process.exit(1);
  }
  console.log(`  identified   ${match}`);

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();
  try {
    const before = await nonDeferrable(client);
    console.log(`\n--- BEFORE ---\n  ${before.length} non-deferrable foreign key(s)`);
    for (const r of before) console.log(`    ${r.tbl}.${r.name}`);

    if (before.length === 0) {
      console.log("\n  Nothing to do. Every foreign key is already deferrable.\n");
      return;
    }
    if (!apply) {
      console.log("\n  Inspect only. Nothing was changed. Re-run with --apply.\n");
      return;
    }

    const answer = await ask(`\n  Type "apply" to make these ${before.length} deferrable: `);
    if (answer !== "apply") {
      console.log("\n  Not confirmed. Nothing was changed.\n");
      process.exit(1);
    }

    console.log(`\n  Applying ${SQL_FILE}…`);
    execFileSync("node", ["scripts/apply-sql.mjs", SQL_FILE], {
      cwd: ROOT,
      stdio: "inherit",
      // Both names, so a DIRECT_URL or DATABASE_URL left in the environment
      // cannot decide which database this touches. The same reason as
      // scripts/migrate-admin-panel.mjs.
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
    });

    const after = await nonDeferrable(client);
    console.log(`\n--- AFTER ---\n  ${after.length} non-deferrable foreign key(s)`);
    for (const r of after) console.log(`    ${r.tbl}.${r.name}`);
    if (after.length > 0) {
      console.error("\n  VERIFICATION FAILED: some foreign keys are still not deferrable.\n");
      process.exit(1);
    }
    console.log(
      "\n  Verified: every foreign key in the public schema is deferrable.\n" +
        "  The deployment gate's foreign-key check will now pass. No data changed.\n",
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\n${scrub(error?.message ?? error)}\n`);
  process.exit(1);
});
