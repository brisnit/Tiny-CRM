#!/usr/bin/env node
/**
 * Applies pending migrations to the **production** database, and proves that is
 * what it did.
 *
 * ## Why this exists rather than `npx prisma migrate deploy`
 *
 * The bare command establishes nothing about which database it reached. It reads
 * `DATABASE_URL` from whatever happens to be in the environment, and a mistyped
 * host, a stale shell export or a copied staging URL all produce the same
 * confident "migrations applied". This script refuses to run until the connection
 * string it was handed matches a known production fingerprint — the same
 * `sha256(hostname/database)` prefix that `scripts/deploy-gate.mjs` prints on
 * every production build, so the two can be compared by eye.
 *
 * ## What it does, in order
 *
 *   1. Reads the owner connection string from a hidden prompt. Never argv (which
 *      is visible in `ps`), never a file, never a log.
 *   2. Fingerprints it and refuses anything that is not production.
 *   3. Warns if the host is the pooled endpoint. Migrations belong on the direct
 *      one — Neon's own guidance, and a transaction pooler rejects some DDL.
 *   4. Lists what is pending and waits for an explicit typed confirmation.
 *   5. Switches the datasource to PostgreSQL and runs `prisma migrate deploy`.
 *   6. Verifies the result against the database rather than trusting the exit
 *      code: the migration row exists, the new columns exist, they are nullable
 *      with no default, and no existing account was backfilled.
 *   7. Restores the local SQLite datasource and regenerates the client, in a
 *      `finally` — so an interrupted or failed run does not leave the checkout
 *      pointing at PostgreSQL with a PostgreSQL client.
 *
 *   node scripts/migrate-production.mjs
 *
 * Read-only rehearsal, which applies nothing:
 *
 *   node scripts/migrate-production.mjs --dry-run
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { promptHidden } from "./lib/prompt-hidden.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const ROOT = resolve(import.meta.dirname, "..");
const SCHEMA = resolve(ROOT, "prisma/schema.prisma");

/**
 * The production database, by fingerprint.
 *
 * `sha256(hostname + "/" + database)`, first 12 hex characters — identical to
 * `databaseFingerprint()` in scripts/deploy-gate.mjs, so the value below can be
 * checked against any production build log.
 *
 * Both endpoints of the same Neon branch are listed. The pooled one is what the
 * application uses and what the build log shows; the direct one is what
 * migrations should use. Neither is a secret: a hostname is not a credential.
 */
const PRODUCTION_FINGERPRINTS = new Map([
  ["18155d6dda02", "production, POOLED endpoint (what the app uses)"],
  ["005bee3e08cc", "production, DIRECT endpoint (what migrations should use)"],
]);

/** The migration this release is for, verified by name after the deploy. */
const EXPECTED_MIGRATION = "20261005120100_terms_acceptance";
const NEW_COLUMNS = ["termsAcceptedVersion", "termsAcceptedAt"];

function fingerprint(url) {
  const parsed = new URL(url);
  return createHash("sha256")
    .update(`${parsed.hostname}/${parsed.pathname.replace(/^\//, "")}`)
    .digest("hex")
    .slice(0, 12);
}

/** Removes anything shaped like a connection string before it can reach a log. */
function scrub(text) {
  return String(text).replace(/postgres(ql)?:\/\/\S+/g, "[connection string redacted]");
}

/**
 * Asks a question, and resolves to "" if stdin closes without an answer.
 *
 * The `close` handler is the whole point. Without it, an EOF — a piped run, a
 * closed terminal — leaves the promise pending forever; node then drains the
 * event loop and exits, skipping the `finally` that restores the local SQLite
 * datasource. Found by rehearsing this script with piped input: the run applied
 * nothing, correctly, but left the checkout pointing at PostgreSQL with a
 * PostgreSQL client. An empty answer fails the confirmation check below, which
 * is the safe direction.
 */
function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((done) => {
    let answered = false;
    const finish = (value) => {
      if (answered) return;
      answered = true;
      rl.close();
      done(value);
    };
    rl.question(question, (answer) => finish(answer.trim()));
    rl.on("close", () => finish(""));
  });
}

function run(command, args, env) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

/** The shipped PostgreSQL migrations, in the order Prisma applies them. */
function shippedMigrations() {
  return readdirSync(resolve(ROOT, "prisma/migrations-postgres"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** The SQL a migration will run, with comments and blank lines removed. */
function statementsOf(name) {
  const sql = readFileSync(
    resolve(ROOT, "prisma/migrations-postgres", name, "migration.sql"),
    "utf8",
  );
  return sql
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("--"));
}

/**
 * Shipped minus applied, read from the database.
 *
 * `_prisma_migrations` is absent on a database Prisma has never touched, which
 * is not an error here — it means everything is pending.
 */
async function pendingMigrations(url) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT migration_name FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL`,
    );
    const applied = new Set(rows.map((row) => row.migration_name));
    return shippedMigrations().filter((name) => !applied.has(name));
  } catch (error) {
    if (/does not exist/i.test(String(error?.message))) return shippedMigrations();
    throw error;
  } finally {
    await client.end();
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  console.log("\nProduction migration" + (dryRun ? " — DRY RUN, nothing will be applied" : ""));
  console.log("=".repeat(64));

  const url = await promptHidden("Owner connection string (input hidden): ");

  let fp;
  try {
    fp = fingerprint(url);
  } catch {
    throw new Error("That is not a parseable connection string.");
  }

  const parsed = new URL(url);
  const match = PRODUCTION_FINGERPRINTS.get(fp);

  console.log(`\n  host         ${parsed.hostname}`);
  console.log(`  database     ${parsed.pathname.replace(/^\//, "")}`);
  console.log(`  fingerprint  ${fp}`);

  if (!match) {
    console.error(
      `\nREFUSED. Fingerprint ${fp} is not a known production database.\n\n` +
        `Expected one of:\n` +
        [...PRODUCTION_FINGERPRINTS].map(([k, v]) => `  ${k}  ${v}`).join("\n") +
        `\n\nCompare against "database fingerprint:" in a production build log.\n` +
        `Nothing was changed.\n`,
    );
    process.exit(1);
  }
  console.log(`  identified   ${match}`);

  if (parsed.hostname.includes("-pooler")) {
    console.log(
      "\n  WARNING: this is the pooled endpoint. Neon's guidance is to run\n" +
        "  migrations over the direct (unpooled) host, and a transaction pooler\n" +
        "  rejects some DDL. Use the host without `-pooler` unless you have a\n" +
        "  reason not to.",
    );
  }

  // Switch the datasource before talking to Prisma: the committed schema says
  // sqlite, and Prisma refuses a postgres URL against a sqlite datasource.
  const original = readFileSync(SCHEMA, "utf8");
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      writeFileSync(SCHEMA, original);
      execFileSync("node", ["scripts/use-provider.mjs", "sqlite"], { cwd: ROOT, stdio: "ignore" });
      execFileSync("npx", ["prisma", "generate"], { cwd: ROOT, stdio: "ignore" });
      console.log("\n  local datasource and client restored to SQLite");
    } catch {
      console.error(
        "\n  Could not restore the local SQLite datasource. Run:\n" +
          "    node scripts/use-provider.mjs sqlite && npx prisma generate\n",
      );
    }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => (restore(), process.exit(130)));
  }

  try {
    run("node", ["scripts/use-provider.mjs", "postgresql"]);
    run("npx", ["prisma", "generate"], { DATABASE_URL: url, DIRECT_URL: url });

    // What is pending, computed rather than scraped.
    //
    // This used to filter `prisma migrate status` output for lines matching
    // /migration|pending|following/. The migration *name* is printed on a line of
    // its own with none of those words, so the one thing an operator needs to see
    // was the one thing the filter dropped — a confirmation prompt that did not
    // say what it was confirming. Diffing the shipped directory against
    // `_prisma_migrations` is exact, and does not depend on parsing CLI prose.
    const pending = await pendingMigrations(url);

    if (pending.length === 0) {
      console.log("\n  Nothing pending — every shipped migration is already applied.");
      console.log("  Nothing to do.\n");
      return;
    }

    console.log(`\n  ${pending.length} migration(s) will be applied, in this order:\n`);
    for (const name of pending) {
      console.log(`    ${name}`);
      for (const statement of statementsOf(name)) {
        console.log(`        ${statement}`);
      }
      console.log("");
    }

    const destructive = pending.flatMap(statementsOf).filter((line) =>
      /\b(DROP|TRUNCATE|DELETE|UPDATE|ALTER\s+COLUMN|SET\s+NOT\s+NULL)\b/i.test(line),
    );
    if (destructive.length > 0) {
      console.log("  WARNING — these statements are not purely additive:");
      for (const line of destructive) console.log(`    ${line}`);
      console.log("");
    } else {
      console.log("  All statements are additive (ADD COLUMN only). No backfill, no data rewritten.\n");
    }

    if (dryRun) {
      console.log("\n  DRY RUN — stopping before `migrate deploy`. Nothing was applied.\n");
      return;
    }

    const confirmation = await ask(
      `\n  Type the fingerprint (${fp}) to apply, or anything else to abort: `,
    );
    if (confirmation !== fp) {
      console.log("\n  Aborted. Nothing was applied.\n");
      return;
    }

    console.log("\n  applying…");
    console.log(scrub(run("npx", ["prisma", "migrate", "deploy"], { DATABASE_URL: url, DIRECT_URL: url })));

    // ---------------------------------------------------------------------
    // Verify against the database, not against the exit code.
    // ---------------------------------------------------------------------
    console.log("  verifying…\n");
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
    await client.connect();
    let failures = 0;
    const check = (ok, label) => {
      console.log(`    ${ok ? "ok  " : "FAIL"}  ${label}`);
      if (!ok) failures += 1;
    };
    try {
      const applied = await client.query(
        `SELECT migration_name, finished_at FROM public."_prisma_migrations" WHERE migration_name = $1`,
        [EXPECTED_MIGRATION],
      );
      check(applied.rows.length === 1, `_prisma_migrations contains ${EXPECTED_MIGRATION}`);
      check(
        applied.rows[0]?.finished_at != null,
        "the migration is recorded as finished, not partially applied",
      );

      const columns = await client.query(
        `SELECT column_name, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = 'User' AND column_name = ANY($1)`,
        [NEW_COLUMNS],
      );
      check(columns.rows.length === NEW_COLUMNS.length, `both columns exist on "User"`);
      for (const row of columns.rows) {
        check(row.is_nullable === "YES", `${row.column_name} is nullable`);
        check(row.column_default === null, `${row.column_name} has no default`);
      }

      // The honest-NULL property: no existing account was given a fabricated
      // acceptance. New signups populate it from here on; nothing backfilled it.
      const backfilled = await client.query(
        `SELECT count(*)::int AS n FROM "User" WHERE "termsAcceptedVersion" IS NOT NULL`,
      );
      check(
        backfilled.rows[0].n === 0,
        `no existing account was backfilled (${backfilled.rows[0].n} rows carry an acceptance)`,
      );

      const total = await client.query(`SELECT count(*)::int AS n FROM "User"`);
      console.log(`\n    ${total.rows[0].n} existing accounts, all recorded as NULL — which means`);
      console.log("    \"no acceptance was recorded\", not \"refused\".");
    } finally {
      await client.end();
    }

    if (failures > 0) {
      console.error(`\n  ${failures} verification check(s) failed. Do not deploy.\n`);
      process.exitCode = 1;
    } else {
      console.log("\n  Verified. The deploy gate will now see this migration as applied.\n");
    }
  } finally {
    restore();
  }
}

main().catch((error) => {
  console.error(`\n${scrub(error instanceof Error ? error.message : error)}\n`);
  process.exit(1);
});
