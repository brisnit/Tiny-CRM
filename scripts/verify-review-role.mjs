#!/usr/bin/env node
/**
 * Proves a review connection is as restricted as it is supposed to be.
 *
 *   node scripts/verify-review-role.mjs
 *
 * Run this BEFORE using the connection for anything. It prompts for the
 * connection string with hidden input; the string is never an argument, never
 * written down, and never printed back.
 *
 * ## Why this exists rather than a checklist
 *
 * Neon grants membership in `neon_superuser` to every role created through
 * its Console, CLI or API — and `neon_superuser` carries BYPASSRLS. A role
 * that was clicked into existence therefore reads every tenant's rows while
 * looking, in the UI, exactly like the restricted role you meant to make.
 * Roles created with SQL do not inherit it.
 *
 * That is not a difference anyone can see by reading a connection string, so
 * it gets asserted against the live connection instead. Each check below is a
 * question the database answers about itself.
 *
 * Nothing here writes. The write checks are attempts that are expected to be
 * refused, each wrapped in its own transaction and rolled back regardless.
 */

import { createRequire } from "node:module";

import { promptHidden } from "./lib/prompt-hidden.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

/** Columns the recipient review reads. Nothing else should be readable. */
const ALLOWED_COLUMNS = [
  "email", "plan", "billingCustomerId",
  "emailVerifiedAt", "deactivatedAt", "lastSeenAt", "createdAt",
];

/**
 * Columns that must NOT be readable. Authentication and MFA state first,
 * then the rest of the row — a review connection has no business reading
 * someone's job title either.
 */
const FORBIDDEN_COLUMNS = [
  "passwordHash", "passwordChangedAt", "failedLoginCount", "lockedUntil",
  "sessionEpoch", "mfaEnabledAt",
  "id", "name", "avatarUrl", "jobTitle", "timezone", "planStatus",
  "planRenewsAt", "termsAcceptedVersion", "termsAcceptedAt", "onboardedAt",
  "deactivatedReason", "updatedAt",
];

/** Tables that must be entirely out of reach. */
const FORBIDDEN_TABLES = [
  "Workspace", "WorkspaceMember", "Contact", "Company", "Deal", "Note",
  "Task", "Activity", "EmailMessage", "CalendarEvent", "FileAsset",
  "AuditLog", "Integration", "AiThread", "AiMessage", "Session",
  "IdempotencyKey", "DomainEvent",
];

const results = [];
const record = (ok, label, detail = "") => {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

async function main() {
  console.log("\nReview-role verification — read-only, asserts restrictions");
  console.log("=".repeat(72));

  // A rehearsal hook, so the procedure can be exercised against a local
  // cluster without a person typing at a prompt. Never set in normal use.
  const url = process.env.REVIEW_URL_FOR_REHEARSAL
    ?? (await promptHidden("Review connection string (input hidden): "));
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();

  try {
    const { rows: [who] } = await client.query(`
      SELECT current_user AS role, current_database() AS db,
             rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
        FROM pg_roles WHERE rolname = current_user
    `);
    console.log(`\n  connected as  ${who.role}  on  ${who.db}\n`);

    // ---- Role attributes --------------------------------------------------
    record(who.rolsuper === false, "not a superuser");
    record(who.rolbypassrls === false, "does NOT have BYPASSRLS",
      who.rolbypassrls ? "this role can read every tenant's rows" : "");
    record(who.rolcreaterole === false, "cannot create roles");
    record(who.rolcreatedb === false, "cannot create databases");
    record(who.rolreplication === false, "cannot replicate");

    // ---- The Neon trap ----------------------------------------------------
    const { rows: memberships } = await client.query(`
      SELECT r.rolname
        FROM pg_auth_members m
        JOIN pg_roles r ON r.oid = m.roleid
        JOIN pg_roles u ON u.oid = m.member
       WHERE u.rolname = current_user
    `);
    const names = memberships.map((r) => r.rolname);
    record(!names.includes("neon_superuser"),
      "not a member of neon_superuser",
      names.length ? `member of: ${names.join(", ")}` : "member of nothing");

    // ---- Column privileges on User ---------------------------------------
    for (const col of ALLOWED_COLUMNS) {
      const { rows: [r] } = await client.query(
        `SELECT has_column_privilege(current_user, '"User"', $1, 'SELECT') AS ok`, [col]);
      record(r.ok === true, `can read User.${col}`);
    }
    for (const col of FORBIDDEN_COLUMNS) {
      const { rows: [r] } = await client.query(
        `SELECT has_column_privilege(current_user, '"User"', $1, 'SELECT') AS ok`, [col]);
      record(r.ok === false, `cannot read User.${col}`,
        r.ok ? "GRANTED — too much" : "");
    }

    // ---- Table privileges -------------------------------------------------
    for (const table of FORBIDDEN_TABLES) {
      const { rows: [r] } = await client.query(
        `SELECT CASE WHEN to_regclass($1) IS NULL THEN NULL
                     ELSE has_table_privilege(current_user, $1, 'SELECT') END AS ok`,
        [`"${table}"`]);
      if (r.ok === null) continue; // table not in this schema; nothing to assert
      record(r.ok === false, `cannot read ${table}`, r.ok ? "GRANTED — too much" : "");
    }

    // ---- Writes -----------------------------------------------------------
    for (const [label, sql] of [
      ["cannot UPDATE User", `UPDATE "User" SET "plan" = "plan"`],
      ["cannot DELETE from User", `DELETE FROM "User" WHERE false`],
      ["cannot INSERT into User", `INSERT INTO "User" ("email") VALUES ('probe@invalid.test')`],
      ["cannot create a table", `CREATE TABLE _probe_should_fail (x int)`],
    ]) {
      await client.query("BEGIN");
      let refused = false;
      try {
        await client.query(sql);
      } catch {
        refused = true;
      }
      await client.query("ROLLBACK");
      record(refused, label, refused ? "" : "the statement was ACCEPTED");
    }

    // ---- And the thing it must be able to do ------------------------------
    try {
      const { rows: [r] } = await client.query(`SELECT count(*)::int AS n FROM "User"`);
      record(typeof r.n === "number", "can count User rows", `${r.n} accounts visible`);
    } catch (error) {
      record(false, "can count User rows", error.message);
    }
  } finally {
    await client.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n" + "=".repeat(72));
  if (failed.length === 0) {
    console.log(`  ALL ${results.length} CHECKS PASSED. This connection is safe to use`);
    console.log("  for the recipient snapshot.\n");
    process.exit(0);
  }
  console.log(`  ${failed.length} of ${results.length} CHECKS FAILED. Do not use this connection:`);
  for (const f of failed) console.log(`    - ${f.label}${f.detail ? `  (${f.detail})` : ""}`);
  console.log("");
  process.exit(1);
}

main().catch((error) => {
  // Never echo the message unscrubbed: a connection error can quote the URL.
  const message = String(error?.message ?? error).replace(
    /postgres(ql)?:\/\/[^\s]*/gi, "[connection string redacted]");
  console.error(`\n${message}\n`);
  process.exit(2);
});
