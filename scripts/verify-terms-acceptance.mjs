#!/usr/bin/env node
/**
 * Confirms, from the production database, what the post-deploy signup checks
 * could only confirm from the outside.
 *
 * The browser run proved the behaviour a visitor sees: the consent box is
 * present, unchecked and `required`; stripping `required` and submitting is
 * refused by the server with "Please accept the terms of service to create an
 * account." and leaves the browser on /signup; checking it creates the account.
 * What a browser cannot see is what was *written* — and that is the whole point
 * of an acceptance record.
 *
 * Read-only. Every statement is a SELECT. Nothing here writes, resolves,
 * migrates or deletes.
 *
 *   node scripts/verify-terms-acceptance.mjs
 *
 * Use the owner connection string on the direct host; the application role is
 * under FORCE row-level security and `User` carries no workspace column, so a
 * scoped connection would answer some of these questions misleadingly.
 *
 * Not committed. The release is pinned to 363a034 / merged as e5bcfdf.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { promptHidden } from "./lib/prompt-hidden.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const ROOT = resolve(import.meta.dirname, "..");

const PRODUCTION_FINGERPRINTS = new Map([
  ["18155d6dda02", "production, POOLED endpoint (what the app uses)"],
  ["005bee3e08cc", "production, DIRECT endpoint (what migrations should use)"],
]);

/** The account created by the dedicated post-deploy signup. */
const ACCEPTED_EMAIL = "brisnit+terms-check-32ff0980@gmail.com";

/**
 * The two submissions that were refused — the first with a 6-second wait that a
 * cold start beat, the second waiting on the error note itself. Both had the
 * `required` attribute stripped in the browser and the box left unchecked, so
 * neither may have produced a row. An absent row is the assertion.
 */
const REFUSED_EMAILS = [
  "brisnit+terms-refused-8786ebf1@gmail.com",
  "brisnit+terms-refused-34b1517d@gmail.com",
];

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

let failures = 0;
function check(ok, label, detail = "") {
  console.log(`    ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function main() {
  console.log("\nTerms-acceptance verification (read-only)");
  console.log("=".repeat(64));

  // Read from the source rather than retyped, so this script cannot disagree
  // with what the pages publish. `node` will not import a .ts file, and adding
  // tsx to an operator script to read one constant is not worth it.
  const legal = readFileSync(resolve(ROOT, "src/lib/legal.ts"), "utf8");
  const found = legal.match(/LEGAL_EFFECTIVE_ON\s*=\s*"(\d{4}-\d{2}-\d{2})"/);
  if (!found) throw new Error("Could not read LEGAL_EFFECTIVE_ON from src/lib/legal.ts.");
  const LEGAL_EFFECTIVE_ON = found[1];
  // TERMS_VERSION is defined as `= LEGAL_EFFECTIVE_ON`; assert that, rather than
  // assuming it, so a future split of the two constants fails here loudly.
  const aliased = /TERMS_VERSION\s*=\s*LEGAL_EFFECTIVE_ON/.test(legal);
  const TERMS_VERSION = LEGAL_EFFECTIVE_ON;
  console.log(`\n  src/lib/legal.ts: LEGAL_EFFECTIVE_ON = ${LEGAL_EFFECTIVE_ON}`);
  check(aliased, "TERMS_VERSION is still the same constant as LEGAL_EFFECTIVE_ON");

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
    console.error(`\nREFUSED. Fingerprint ${fp} is not a known production database.\nNothing was read.\n`);
    process.exit(1);
  }
  console.log(`  identified   ${match}`);

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();
  try {
    // ------------------------------------------------------------------
    // 1. The dedicated signup recorded the right version, at the right time.
    // ------------------------------------------------------------------
    console.log("\n  1. THE DEDICATED NEW SIGNUP");
    const accepted = await client.query(
      `SELECT "email", "createdAt", "termsAcceptedVersion", "termsAcceptedAt"
         FROM "User" WHERE "email" = $1`,
      [ACCEPTED_EMAIL],
    );
    check(accepted.rows.length === 1, `exactly one account for ${ACCEPTED_EMAIL}`, `${accepted.rows.length} row(s)`);
    const row = accepted.rows[0];
    if (row) {
      console.log(`      createdAt            ${row.createdAt?.toISOString?.() ?? row.createdAt}`);
      console.log(`      termsAcceptedVersion ${row.termsAcceptedVersion ?? "NULL"}`);
      console.log(`      termsAcceptedAt      ${row.termsAcceptedAt?.toISOString?.() ?? "NULL"}`);
      check(
        row.termsAcceptedVersion === TERMS_VERSION,
        `the recorded version is ${TERMS_VERSION}`,
        String(row.termsAcceptedVersion),
      );
      check(
        TERMS_VERSION === LEGAL_EFFECTIVE_ON,
        "the recorded version and the published effective date are the same constant",
      );
      check(row.termsAcceptedAt != null, "an acceptance timestamp was recorded");
      // The timestamp must be when the agreement happened, not the version date.
      if (row.termsAcceptedAt && row.createdAt) {
        const gap = Math.abs(row.termsAcceptedAt.getTime() - row.createdAt.getTime());
        check(gap < 60_000, "the acceptance timestamp matches when the account was created", `${gap} ms apart`);
      }
    }

    // ------------------------------------------------------------------
    // 2. The refused submissions created nothing.
    // ------------------------------------------------------------------
    console.log("\n  2. THE REFUSED SUBMISSIONS");
    for (const email of REFUSED_EMAILS) {
      const { rows } = await client.query(`SELECT 1 FROM "User" WHERE "email" = $1`, [email]);
      check(rows.length === 0, `no account exists for ${email}`, `${rows.length} row(s)`);
    }

    // ------------------------------------------------------------------
    // 3. Existing accounts are still honestly NULL.
    // ------------------------------------------------------------------
    console.log("\n  3. EXISTING ACCOUNTS");
    const counts = await client.query(
      `SELECT count(*)::int AS total,
              count("termsAcceptedVersion")::int AS with_version,
              count("termsAcceptedAt")::int AS with_timestamp
         FROM "User"`,
    );
    const c = counts.rows[0];
    console.log(`      total accounts                  ${c.total}`);
    console.log(`      with a recorded version         ${c.with_version}`);
    console.log(`      with a recorded timestamp       ${c.with_timestamp}`);
    check(
      c.with_version === 1,
      "exactly one account carries an acceptance — the one just created",
      `${c.with_version}`,
    );
    check(c.with_version === c.with_timestamp, "version and timestamp are set together, never one alone");
    check(
      c.total - c.with_version >= 1,
      "every pre-existing account is still NULL — nothing was backfilled",
      `${c.total - c.with_version} NULL`,
    );

    // A fabricated acceptance would be one dated before the signup existed.
    const impossible = await client.query(
      `SELECT count(*)::int AS n FROM "User"
        WHERE "termsAcceptedAt" IS NOT NULL AND "termsAcceptedAt" < "createdAt" - interval '1 minute'`,
    );
    check(
      impossible.rows[0].n === 0,
      "no account claims it accepted before it existed",
      `${impossible.rows[0].n}`,
    );
  } finally {
    await client.end();
  }

  console.log(`\n  ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  console.log("  Read-only. Nothing was changed.\n");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n${scrub(error?.message ?? error)}\n`);
  process.exit(1);
});
