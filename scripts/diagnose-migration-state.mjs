#!/usr/bin/env node
/**
 * Why `20261005120100_terms_acceptance` failed with P3018 / 42501, answered from
 * the database rather than from inference.
 *
 * ## The gap this exists to close
 *
 * `scripts/migrate-production.mjs` fingerprints `sha256(hostname/database)`. That
 * proves **which database** the connection reaches and says nothing at all about
 * **which role** it authenticates as — the owner URL and the application URL for
 * the same Neon branch produce the *same* fingerprint. So the guard passed, and
 * `prisma migrate deploy` then ran `ALTER TABLE "User"` as a role that does not
 * own the table. PostgreSQL refused it, correctly: 42501, `must be owner of table
 * User`.
 *
 * Nothing here writes. Every statement is a `SELECT` against a catalog or
 * `information_schema`, with one deliberate exception behind an explicit flag —
 * see below.
 *
 *   node scripts/diagnose-migration-state.mjs
 *
 * ## The one writing mode, and what it must prove first
 *
 *   node scripts/diagnose-migration-state.mjs --resolve-rolled-back
 *
 * Marks the failed migration as rolled back so `migrate deploy` will attempt it
 * again. It refuses unless the diagnosis has just established, in this run, that
 *
 *   - the recorded attempt is genuinely unfinished (`finished_at IS NULL`), and
 *   - **neither** acceptance column exists.
 *
 * Both conditions are checked again immediately before the resolve, and the mode
 * fails closed on anything unexpected. Resolving as rolled-back while half the
 * DDL is in place would tell Prisma to re-run `ADD COLUMN` against a column that
 * already exists, which fails on the retry and leaves a second failed row. The
 * opposite mistake is worse: `--applied` on a migration whose columns are absent
 * records a schema change that never happened, and every later migration is then
 * computed from a schema the database does not have.
 *
 * This file is deliberately **not committed**. The release is pinned to 363a034.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { promptHidden } from "./lib/prompt-hidden.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const ROOT = resolve(import.meta.dirname, "..");
const SCHEMA = resolve(ROOT, "prisma/schema.prisma");

/** Identical to migrate-production.mjs and deploy-gate.mjs. A host is not a secret. */
const PRODUCTION_FINGERPRINTS = new Map([
  ["18155d6dda02", "production, POOLED endpoint (what the app uses)"],
  ["005bee3e08cc", "production, DIRECT endpoint (what migrations should use)"],
]);

const MIGRATION = "20261005120100_terms_acceptance";
const NEW_COLUMNS = ["termsAcceptedVersion", "termsAcceptedAt"];

function fingerprint(url) {
  const parsed = new URL(url);
  return createHash("sha256")
    .update(`${parsed.hostname}/${parsed.pathname.replace(/^\//, "")}`)
    .digest("hex")
    .slice(0, 12);
}

function scrub(text) {
  return String(text).replace(/postgres(ql)?:\/\/\S+/g, "[connection string redacted]");
}

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

/**
 * One query, and a reason when it cannot be answered.
 *
 * A role that lacks SELECT on `_prisma_migrations` should produce a line saying
 * so, not abort the whole diagnosis — the point of this script is to report what
 * is true, including "this role cannot see that".
 */
async function tryQuery(client, label, sql, params = []) {
  try {
    const { rows } = await client.query(sql, params);
    return { ok: true, rows };
  } catch (error) {
    console.log(`    (${label}: ${scrub(error?.message ?? error)})`);
    return { ok: false, rows: [] };
  }
}

async function main() {
  const resolveRolledBack = process.argv.includes("--resolve-rolled-back");

  console.log("\nMigration failure diagnosis" + (resolveRolledBack ? " + resolve as rolled back" : " (read-only)"));
  console.log("=".repeat(70));

  const url = await promptHidden("Connection string (input hidden): ");

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
      `\nREFUSED. Fingerprint ${fp} is not a known production database.\n` +
        `Nothing was read.\n`,
    );
    process.exit(1);
  }
  console.log(`  identified   ${match}`);
  if (parsed.hostname.includes("-pooler")) {
    console.log("\n  NOTE: pooled endpoint. Migrations belong on the direct host.");
  }

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();

  let connectedRole = null;
  let tableOwner = null;
  let canAlter = false;
  let columnsPresent = [];
  let attemptRow = null;

  try {
    // -------------------------------------------------------------------
    // 1. Who am I, actually?
    // -------------------------------------------------------------------
    console.log("\n  1. CONNECTED ROLE");
    const who = await tryQuery(
      client,
      "identity",
      `SELECT current_user AS current_role_name,
              session_user  AS session_role_name,
              current_database() AS db,
              version() AS server`,
    );
    if (who.rows[0]) {
      connectedRole = who.rows[0].current_role_name;
      console.log(`    current_user      ${who.rows[0].current_role_name}`);
      console.log(`    session_user      ${who.rows[0].session_role_name}`);
      console.log(`    current_database  ${who.rows[0].db}`);
      console.log(`    server            ${String(who.rows[0].server).split(" on ")[0]}`);
    }

    const attrs = await tryQuery(
      client,
      "role attributes",
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolcanlogin
         FROM pg_roles WHERE rolname = current_user`,
    );
    if (attrs.rows[0]) {
      const a = attrs.rows[0];
      console.log(
        `    attributes        superuser=${a.rolsuper} bypassrls=${a.rolbypassrls} ` +
          `createdb=${a.rolcreatedb} createrole=${a.rolcreaterole} inherit=${a.rolinherit}`,
      );
    }

    const memberOf = await tryQuery(
      client,
      "role memberships",
      `SELECT r.rolname
         FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.roleid
        WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
        ORDER BY r.rolname`,
    );
    console.log(
      `    member of         ${memberOf.rows.length ? memberOf.rows.map((r) => r.rolname).join(", ") : "(nothing)"}`,
    );

    // -------------------------------------------------------------------
    // 2. Who owns "User"?
    // -------------------------------------------------------------------
    console.log('\n  2. OWNERSHIP OF "User"');
    const owner = await tryQuery(
      client,
      "table owner",
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'User'`,
    );
    if (owner.rows[0]) {
      tableOwner = owner.rows[0].tableowner;
      console.log(`    owner             ${tableOwner}`);
      console.log(`    connected as      ${connectedRole}`);
      console.log(`    same role?        ${tableOwner === connectedRole ? "YES" : "NO  <-- this is the failure"}`);
    }

    // ALTER TABLE requires being the owner, a member of the owning role, or a
    // superuser. `pg_has_role(..., 'USAGE')` is exactly "can act as that role".
    const hasRole = await tryQuery(
      client,
      "pg_has_role",
      `SELECT pg_has_role(current_user, $1, 'USAGE') AS can_act,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_super`,
      [tableOwner],
    );
    if (hasRole.rows[0]) {
      canAlter = hasRole.rows[0].can_act === true || hasRole.rows[0].is_super === true;
      console.log(`    can act as owner  ${hasRole.rows[0].can_act}`);
      console.log(`    CAN ALTER "User"  ${canAlter ? "YES" : "NO"}`);
    }

    const owners = await tryQuery(
      client,
      "owners in public",
      `SELECT tableowner, count(*)::int AS tables
         FROM pg_tables WHERE schemaname = 'public'
        GROUP BY tableowner ORDER BY tables DESC`,
    );
    if (owners.rows.length) {
      console.log("    public schema owned by:");
      for (const r of owners.rows) console.log(`      ${r.tableowner}  (${r.tables} tables)`);
    }

    const logins = await tryQuery(
      client,
      "login roles",
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
        WHERE rolcanlogin ORDER BY rolname`,
    );
    if (logins.rows.length) {
      console.log("    roles that can log in:");
      for (const r of logins.rows) {
        console.log(`      ${r.rolname}  superuser=${r.rolsuper} bypassrls=${r.rolbypassrls}`);
      }
    }

    // -------------------------------------------------------------------
    // 3. Did either column land?
    // -------------------------------------------------------------------
    console.log('\n  3. ACCEPTANCE COLUMNS ON "User"');
    const cols = await tryQuery(
      client,
      "columns",
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'User' AND column_name = ANY($1)
        ORDER BY column_name`,
      [NEW_COLUMNS],
    );
    columnsPresent = cols.rows.map((r) => r.column_name);
    for (const name of NEW_COLUMNS) {
      const row = cols.rows.find((r) => r.column_name === name);
      console.log(
        row
          ? `    PRESENT  ${name}  ${row.data_type}  nullable=${row.is_nullable}  default=${row.column_default ?? "none"}`
          : `    ABSENT   ${name}`,
      );
    }

    // -------------------------------------------------------------------
    // 4. What did Prisma record?
    // -------------------------------------------------------------------
    console.log("\n  4. _prisma_migrations");
    const attempt = await tryQuery(
      client,
      "migration row",
      `SELECT id, migration_name, started_at, finished_at, applied_steps_count,
              rolled_back_at, logs
         FROM public."_prisma_migrations"
        WHERE migration_name = $1
        ORDER BY started_at`,
      [MIGRATION],
    );
    if (attempt.rows.length === 0) {
      console.log(`    no row for ${MIGRATION}`);
    }
    console.log(`    ${attempt.rows.length} record(s) for ${MIGRATION}\n`);
    for (const row of attempt.rows) {
      console.log(`    migration_name       ${row.migration_name}`);
      console.log(`    id                   ${row.id}`);
      console.log(`    started_at           ${row.started_at?.toISOString?.() ?? row.started_at}`);
      console.log(`    finished_at          ${row.finished_at?.toISOString?.() ?? row.finished_at ?? "NULL  <-- unfinished"}`);
      console.log(`    rolled_back_at       ${row.rolled_back_at?.toISOString?.() ?? row.rolled_back_at ?? "NULL"}`);
      console.log(`    applied_steps_count  ${row.applied_steps_count}`);
      if (row.logs) {
        console.log("    logs:");
        for (const line of scrub(row.logs).split("\n")) console.log(`      ${line}`);
      }
      console.log("");
    }

    // -------------------------------------------------------------------
    // 4b. The assertions that are actually about correctness.
    //
    // Prisma keeps history. `migrate resolve --rolled-back` stamps
    // `rolled_back_at` on the failed row and leaves it in place; the retry then
    // INSERTs a *new* row with the same migration_name. So a rolled-back attempt
    // followed by a successful retry legitimately leaves TWO records, and any
    // check of the form `rows.length === 1` is asserting "this migration was
    // never retried" — not "this migration is applied". Measured locally against
    // SQLite by reproducing exactly this sequence: 2 rows, one rolled back with
    // the error in `logs`, one finished with applied_steps_count = 1.
    //
    // What matters is the *state*, as a set.
    // -------------------------------------------------------------------
    const finishedLive = attempt.rows.filter(
      (r) => r.finished_at != null && r.rolled_back_at == null,
    );
    const rolledBack = attempt.rows.filter((r) => r.rolled_back_at != null);
    const unresolved = attempt.rows.filter(
      (r) => r.finished_at == null && r.rolled_back_at == null,
    );
    attemptRow = unresolved[0] ?? attempt.rows[attempt.rows.length - 1] ?? null;

    console.log("    classification:");
    console.log(`      finished, not rolled back   ${finishedLive.length}`);
    console.log(`      rolled back (history)       ${rolledBack.length}`);
    console.log(`      unresolved failed attempt   ${unresolved.length}`);
    console.log("");
    console.log("    assertions:");
    console.log(
      `      ${finishedLive.length === 1 ? "ok  " : "FAIL"}  exactly one successfully finished, non-rolled-back record`,
    );
    console.log(
      `      ${unresolved.length === 0 ? "ok  " : "FAIL"}  no unresolved failed attempt`,
    );

    // Exactly the query scripts/deploy-gate.mjs runs, so you can see in advance
    // what the production build will conclude. The gate is set-based and already
    // filters rolled-back rows, so duplicate history does not trip it.
    const gate = await tryQuery(
      client,
      "deploy-gate view",
      `SELECT count(*)::int AS n FROM public."_prisma_migrations"
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name = $1`,
      [MIGRATION],
    );
    if (gate.rows[0]) {
      console.log(
        `      ${gate.rows[0].n === 1 ? "ok  " : "FAIL"}  the deploy gate counts it as applied exactly once (${gate.rows[0].n})`,
      );
    }

    const tail = await tryQuery(
      client,
      "recent migrations",
      `SELECT migration_name, finished_at, rolled_back_at
         FROM public."_prisma_migrations"
        ORDER BY started_at DESC LIMIT 6`,
    );
    if (tail.rows.length) {
      console.log("\n    six most recent rows:");
      for (const r of tail.rows) {
        const state = r.rolled_back_at
          ? "ROLLED BACK"
          : r.finished_at
            ? "finished"
            : "UNFINISHED";
        console.log(`      ${state.padEnd(11)}  ${r.migration_name}`);
      }
    }

    // -------------------------------------------------------------------
    // 5. Verdict
    // -------------------------------------------------------------------
    console.log("\n  5. VERDICT");
    if (columnsPresent.length === 0) {
      console.log("    Neither column exists. The DDL did not take effect.");
      console.log("    The recorded attempt should be resolved as ROLLED BACK, then retried");
      console.log("    with a connection whose role can ALTER \"User\".");
    } else if (columnsPresent.length === NEW_COLUMNS.length) {
      console.log("    Both columns exist. The DDL DID take effect even though Prisma");
      console.log("    recorded a failure — do NOT resolve this as rolled back; a retry");
      console.log("    would run ADD COLUMN against columns that are already there.");
      console.log("    This is the --applied case, and only after checking nullability.");
    } else {
      console.log(`    PARTIAL: ${columnsPresent.join(", ")} present, the other absent.`);
      console.log("    Neither resolve direction is correct. Stop and decide by hand.");
    }
    if (!canAlter) {
      console.log(`    This connection CANNOT alter "User" (role ${connectedRole}, owner ${tableOwner}).`);
      console.log("    Retrying with this connection string will fail again, identically.");
    }
  } finally {
    await client.end();
  }

  if (!resolveRolledBack) {
    console.log("\n  Read-only. Nothing was changed.\n");
    return;
  }

  // ---------------------------------------------------------------------
  // The writing mode. Fails closed.
  // ---------------------------------------------------------------------
  console.log("\n  RESOLVE AS ROLLED BACK");

  if (columnsPresent.length !== 0) {
    console.error(
      `\n  REFUSED. ${columnsPresent.length} of ${NEW_COLUMNS.length} column(s) exist ` +
        `(${columnsPresent.join(", ")}).\n` +
        `  Rolled-back is only correct when the DDL left nothing behind.\n  Nothing was changed.\n`,
    );
    process.exit(1);
  }
  // `_prisma_migrations` is owned by the same role that owns the tables, so a
  // connection that could not ALTER "User" cannot UPDATE that row either. Refuse
  // here rather than let `migrate resolve` fail halfway and leave the checkout
  // switched to PostgreSQL for no gain.
  if (!canAlter) {
    console.error(
      `\n  REFUSED. This connection authenticates as ${connectedRole}, which cannot act\n` +
        `  as ${tableOwner}. Resolving writes to _prisma_migrations and needs the owner.\n` +
        `  Re-run with the owner connection string. Nothing was changed.\n`,
    );
    process.exit(1);
  }
  if (!attemptRow) {
    console.error(
      `\n  REFUSED. There is no recorded attempt at ${MIGRATION} to resolve.\n` +
        `  Nothing was changed.\n`,
    );
    process.exit(1);
  }
  if (attemptRow.finished_at != null) {
    console.error(
      `\n  REFUSED. The recorded attempt is already finished, not failed.\n  Nothing was changed.\n`,
    );
    process.exit(1);
  }
  if (attemptRow.rolled_back_at != null) {
    console.log("\n  Already marked rolled back. Nothing to do.\n");
    return;
  }

  const confirmation = await ask(
    `\n  Type the fingerprint (${fp}) to mark ${MIGRATION} rolled back: `,
  );
  if (confirmation !== fp) {
    console.log("\n  Aborted. Nothing was changed.\n");
    return;
  }

  // Prisma needs the datasource to match the URL, exactly as migrate-production
  // does, and the local checkout must be put back whatever happens.
  const original = readFileSync(SCHEMA, "utf8");
  let restored = false;
  const restoreLocal = () => {
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
    process.on(signal, () => (restoreLocal(), process.exit(130)));
  }

  try {
    execFileSync("node", ["scripts/use-provider.mjs", "postgresql"], { cwd: ROOT, stdio: "ignore" });
    const out = execFileSync(
      "npx",
      ["prisma", "migrate", "resolve", "--rolled-back", MIGRATION],
      { cwd: ROOT, encoding: "utf8", env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url } },
    );
    console.log(scrub(out));

    // Confirm from the database rather than from the exit code.
    const after = new Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
    await after.connect();
    try {
      const { rows } = await after.query(
        `SELECT finished_at, rolled_back_at FROM public."_prisma_migrations"
          WHERE migration_name = $1 ORDER BY started_at DESC LIMIT 1`,
        [MIGRATION],
      );
      const row = rows[0];
      const ok = row && row.rolled_back_at != null;
      console.log(`    ${ok ? "ok  " : "FAIL"}  ${MIGRATION} is recorded as rolled back`);
      const cols = await after.query(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_schema='public' AND table_name='User' AND column_name = ANY($1)`,
        [NEW_COLUMNS],
      );
      console.log(`    ${cols.rows[0].n === 0 ? "ok  " : "FAIL"}  still 0 acceptance columns (${cols.rows[0].n})`);
      if (!ok) process.exitCode = 1;
      else console.log("\n  Ready to retry: node scripts/migrate-production.mjs\n");
    } finally {
      await after.end();
    }
  } finally {
    restoreLocal();
  }
}

main().catch((error) => {
  console.error(`\n${scrub(error?.message ?? error)}\n`);
  process.exit(1);
});
