#!/usr/bin/env node
/**
 * Resolves an email address to the stable user id administration binds to.
 *
 * Read-only. Exists because the binding must be an **id**, not an address: an
 * address is something a browser supplies and something a later registration
 * can choose, and binding to one would mean administration could be acquired
 * by signing up. So the id is resolved once, deliberately, out of band, and
 * written by migration.
 *
 *   node scripts/resolve-admin-user.mjs hello@artifactdigital.co
 *
 * Prints nothing secret: an id, a plan, a date. It refuses any database whose
 * fingerprint is not a known production one, and it refuses to guess when an
 * address matches more than one account.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { promptHidden } from "./lib/prompt-hidden.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

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

async function main() {
  const email = process.argv[2];
  if (!email || !email.includes("@")) {
    throw new Error('Usage: node scripts/resolve-admin-user.mjs "<email>"');
  }

  console.log(`\nResolving: ${email}`);
  console.log("=".repeat(70));

  const url = await promptHidden("Connection string (input hidden): ");
  let fp;
  try {
    fp = fingerprint(url);
  } catch {
    throw new Error("That is not a parseable connection string.");
  }
  const match = PRODUCTION_FINGERPRINTS.get(fp);
  console.log(`\n  fingerprint  ${fp}`);
  if (!match) {
    console.error("\nREFUSED. Not a known production database. Nothing was read.\n");
    process.exit(1);
  }
  console.log(`  identified   ${match}`);

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();
  try {
    // Case-insensitive, because an address typed into a prompt is not
    // necessarily cased as it was stored, and binding the wrong id is the
    // failure this script exists to prevent.
    const { rows } = await client.query(
      `SELECT u."id", u."email", u."name", u."plan", u."createdAt", u."deactivatedAt",
              (SELECT count(*)::int FROM "PlatformAdmin" pa WHERE pa."userId" = u."id") AS is_admin,
              (SELECT count(*)::int FROM "Workspace" w WHERE w."ownerId" = u."id") AS owned
         FROM "User" u
        WHERE lower(u."email") = lower($1)`,
      [email],
    );

    if (rows.length === 0) {
      console.error(`\nNo account with that address. Nothing to bind.\n`);
      process.exit(1);
    }
    if (rows.length > 1) {
      console.error(`\nREFUSED: ${rows.length} accounts match. Resolve by hand before binding.\n`);
      process.exit(1);
    }

    const u = rows[0];
    console.log("\n  ACCOUNT");
    console.log(`    id              ${u.id}`);
    console.log(`    email           ${u.email}`);
    console.log(`    name            ${u.name}`);
    console.log(`    stored plan     ${u.plan}`);
    console.log(`    registered      ${u.createdAt?.toISOString?.().slice(0, 10) ?? u.createdAt}`);
    console.log(`    suspended       ${u.deactivatedAt ? "YES" : "no"}`);
    console.log(`    workspaces owned ${u.owned}`);
    console.log(`    already admin   ${u.is_admin > 0 ? "YES" : "no"}`);
    console.log(`\n  To bind:  node scripts/bind-platform-admin.mjs ${u.id}\n`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\n${scrub(error?.message ?? error)}\n`);
  process.exit(1);
});
