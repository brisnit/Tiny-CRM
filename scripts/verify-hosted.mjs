#!/usr/bin/env node
/**
 * Hosted environment verification.
 *
 * Everything here asks the *database* what is true rather than trusting how it
 * was configured. It is meant to be run against a real managed PostgreSQL —
 * the one the deployment will actually use — after migrations and the RLS SQL
 * have been applied.
 *
 *   ADMIN_URL='postgresql://<owner>:...@<direct-host>/<db>?sslmode=require' \
 *   APP_URL_DB='postgresql://tinycrm_app:...@<pooled-host>/<db>?sslmode=require' \
 *   node scripts/verify-hosted.mjs
 *
 * ADMIN_URL is optional: without it the checks that need to see another
 * tenant's rows are skipped and reported as skipped, not as passes.
 *
 * Exit code 0 only if every executed check passed.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const APP_DB = process.env.APP_URL_DB ?? process.env.RLS_APP_DATABASE_URL;
const ADMIN_DB = process.env.ADMIN_URL;

if (!APP_DB) {
  console.error(
    "APP_URL_DB is required: the connection string the deployed application uses\n" +
      "(the tinycrm_app role, pooled endpoint).",
  );
  process.exit(2);
}

let passed = 0;
let failed = 0;
let skipped = 0;

const pass = (name, detail = "") => {
  passed += 1;
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
};
const fail = (name, detail = "") => {
  failed += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
};
const skip = (name, why) => {
  skipped += 1;
  console.log(`  SKIP  ${name} — ${why}`);
};

async function connect(url, label) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  try {
    await client.connect();
    return client;
  } catch (error) {
    console.error(`\nCould not connect as ${label}: ${String(error.message ?? error)}`);
    process.exit(2);
  }
}

async function main() {
  console.log("Hosted environment verification\n" + "=".repeat(64));

  const app = await connect(APP_DB, "the application role");

  // -------------------------------------------------------------------------
  console.log("\n[1] Server");

  const version = (await app.query("SHOW server_version")).rows[0].server_version;
  const major = Number.parseInt(version, 10);
  if (major >= 17) pass("PostgreSQL 17 or newer", version);
  else fail("PostgreSQL 17 or newer", `found ${version}`);

  const ssl = (await app.query("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")).rows[0];
  const host = /@([^:/?]+)/.exec(APP_DB)?.[1] ?? "";
  const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (ssl?.ssl) {
    pass("connection is encrypted (TLS)");
  } else if (isLoopback) {
    // A loopback cluster never leaves the machine, so cleartext is not a
    // finding. Reported as a skip rather than a pass: this run has not
    // demonstrated anything about the hosted deployment's transport.
    skip("connection is encrypted (TLS)", `${host} is loopback — nothing to intercept, but this proves nothing about the hosted database`);
  } else {
    fail("connection is encrypted (TLS)", "this connection to a remote host is in cleartext — add ?sslmode=require");
  }

  // -------------------------------------------------------------------------
  console.log("\n[2] The runtime role is actually unprivileged");

  const who = (
    await app.query(`
      SELECT current_user AS who,
             r.rolsuper    AS is_super,
             r.rolbypassrls AS bypass_rls,
             r.rolcreatedb AS can_create_db,
             r.rolcreaterole AS can_create_role
      FROM pg_roles r WHERE r.rolname = current_user
    `)
  ).rows[0];

  console.log(`        connected as: ${who.who}`);

  if (!who.is_super) pass("not a superuser");
  else fail("not a superuser", "FORCE ROW LEVEL SECURITY does not bind a superuser — RLS is not protecting this connection");

  if (!who.bypass_rls) pass("rolbypassrls = false");
  else fail("rolbypassrls = false", "this role bypasses every policy");

  if (!who.can_create_db) pass("cannot create databases");
  else fail("cannot create databases");

  if (!who.can_create_role) pass("cannot create roles");
  else fail("cannot create roles");

  const owns = (
    await app.query(`
      SELECT count(*)::int AS n
      FROM pg_tables
      WHERE schemaname = 'public' AND tableowner = current_user
    `)
  ).rows[0].n;
  if (owns === 0) pass("does not own any application table");
  else fail("does not own any application table", `owns ${owns} — FORCE RLS binds the owner, but ownership also permits DDL`);

  // -------------------------------------------------------------------------
  console.log("\n[3] Row-level security is enabled and forced");

  const rls = (
    await app.query(`
      SELECT c.relname AS table,
             c.relrowsecurity AS enabled,
             c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
    `)
  ).rows;

  const withRls = rls.filter((t) => t.enabled);
  const notForced = withRls.filter((t) => !t.forced);
  const noPolicy = withRls.filter((t) => t.policies === 0);

  console.log(`        ${rls.length} tables, ${withRls.length} with RLS enabled`);

  if (withRls.length >= 30) pass(`RLS enabled on ${withRls.length} tables`);
  else fail(`RLS enabled on ${withRls.length} tables`, "expected at least 30 — was 002_row_level_security.sql applied?");

  if (notForced.length === 0) pass("every RLS table also has FORCE");
  else fail("every RLS table also has FORCE", `${notForced.length} without: ${notForced.slice(0, 5).map((t) => t.table).join(", ")}`);

  if (noPolicy.length === 0) pass("every RLS table has at least one policy");
  else fail("every RLS table has at least one policy", `${noPolicy.length} without: ${noPolicy.slice(0, 5).map((t) => t.table).join(", ")}`);

  // -------------------------------------------------------------------------
  console.log("\n[4] Deny by default, without a tenant context");

  // No app.workspace_ids set: every policy compares against NULL, which is not
  // TRUE, so nothing is visible. This is the property that makes a forgotten
  // application-level filter safe rather than catastrophic.
  const blind = (await app.query('SELECT count(*)::int AS n FROM "Contact"')).rows[0].n;
  if (blind === 0) pass("SELECT * FROM Contact with no tenant context returns 0 rows");
  else fail("SELECT * FROM Contact with no tenant context returns 0 rows", `returned ${blind} — RLS is not protecting this connection`);

  const blindNotes = (await app.query('SELECT count(*)::int AS n FROM "Note"')).rows[0].n;
  if (blindNotes === 0) pass("SELECT * FROM Note with no tenant context returns 0 rows");
  else fail("SELECT * FROM Note with no tenant context returns 0 rows", `returned ${blindNotes}`);

  // -------------------------------------------------------------------------
  console.log("\n[5] The audit log is append-only for the runtime role");

  for (const [verb, sql] of [
    ["UPDATE", `UPDATE "AuditLog" SET action = 'tampered' WHERE true`],
    ["DELETE", `DELETE FROM "AuditLog" WHERE true`],
  ]) {
    try {
      await app.query("BEGIN");
      await app.query(sql);
      await app.query("ROLLBACK");
      fail(`${verb} on AuditLog is refused`, "it was permitted");
    } catch (error) {
      await app.query("ROLLBACK").catch(() => {});
      if (/permission denied/i.test(String(error.message))) pass(`${verb} on AuditLog is refused`);
      else fail(`${verb} on AuditLog is refused`, String(error.message).slice(0, 90));
    }
  }

  // -------------------------------------------------------------------------
  console.log("\n[6] Cross-tenant isolation with a real tenant context");

  if (!ADMIN_DB) {
    skip("cross-tenant read", "ADMIN_URL not provided, so no second tenant can be observed");
  } else {
    const admin = await connect(ADMIN_DB, "the admin role");
    try {
      const workspaces = (
        await admin.query('SELECT id FROM "Workspace" ORDER BY "createdAt" LIMIT 2')
      ).rows;

      if (workspaces.length < 2) {
        skip("cross-tenant read", `only ${workspaces.length} workspace(s) exist — create two to test isolation`);
      } else {
        const [a, b] = workspaces;

        const total = (await admin.query('SELECT count(*)::int AS n FROM "Contact"')).rows[0].n;

        // Scope the app connection to workspace A only.
        await app.query("BEGIN");
        await app.query("SELECT set_config('app.workspace_ids', $1, true)", [a.id]);
        const visible = (await app.query('SELECT count(*)::int AS n FROM "Contact"')).rows[0].n;
        const leaked = (
          await app.query('SELECT count(*)::int AS n FROM "Contact" WHERE "workspaceId" = $1', [b.id])
        ).rows[0].n;
        await app.query("ROLLBACK");

        console.log(`        contacts: ${total} total, ${visible} visible scoped to workspace A`);

        if (leaked === 0) pass("scoped to workspace A, workspace B's contacts are invisible");
        else fail("scoped to workspace A, workspace B's contacts are invisible", `${leaked} rows leaked`);

        if (visible < total) pass("the scoped view is a strict subset of all rows");
        else if (total === 0) skip("the scoped view is a strict subset", "no contact rows exist yet");
        else fail("the scoped view is a strict subset of all rows", `saw all ${total}`);

        // A forged context for a workspace the caller does not belong to still
        // only ever yields that workspace's rows — the guard that matters is
        // that the application never sets an id the actor cannot access.
        await app.query("BEGIN");
        await app.query("SELECT set_config('app.workspace_ids', $1, true)", ["not-a-real-id"]);
        const forged = (await app.query('SELECT count(*)::int AS n FROM "Contact"')).rows[0].n;
        await app.query("ROLLBACK");
        if (forged === 0) pass("an unknown workspace id yields nothing");
        else fail("an unknown workspace id yields nothing", `returned ${forged}`);
      }
    } finally {
      await admin.end().catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  console.log("\n[7] Schema is present and current");

  const tables = (
    await admin_or_app_count(app, ADMIN_DB)
  );
  if (tables >= 40) pass(`${tables} tables present`);
  else fail(`${tables} tables present`, "expected 40+ — did prisma migrate deploy run?");

  const trgm = (await app.query("SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pg_trgm'")).rows[0].n;
  if (trgm === 1) pass("pg_trgm extension installed (search indexes)");
  else fail("pg_trgm extension installed", "001_search_indexes.sql has not been applied");

  const deferrable = (
    await app.query(`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE contype = 'f' AND condeferrable
    `)
  ).rows[0].n;
  if (deferrable > 0) pass(`${deferrable} deferrable foreign keys (restore is possible)`);
  else fail("deferrable foreign keys", "003_deferrable_constraints.sql has not been applied — a logical restore will fail");

  await app.end().catch(() => {});

  // -------------------------------------------------------------------------
  console.log("\n" + "=".repeat(64));
  console.log(`  passed ${passed}   failed ${failed}   skipped ${skipped}`);
  console.log("=".repeat(64));
  console.log(`\nHOSTED RLS VERIFIED: ${failed === 0 && skipped === 0 ? "YES" : failed === 0 ? "PARTIAL — checks were skipped" : "NO"}\n`);

  process.exit(failed === 0 ? 0 : 1);
}

async function admin_or_app_count(app) {
  const r = await app.query(`
    SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  return r.rows[0].n;
}

main().catch((error) => {
  console.error("\n" + String(error?.stack ?? error));
  process.exit(2);
});
