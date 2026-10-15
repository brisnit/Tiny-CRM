#!/usr/bin/env node
/**
 * Counts who a privacy-notice email would reach. Sends nothing, ever.
 *
 *   node scripts/notice-recipients.mjs            # counts only
 *   node scripts/notice-recipients.mjs --sample   # counts + 5 redacted addresses
 *
 * ## There is no send mode and there should not be one
 *
 * This script has no code path that delivers mail. Counting the audience and
 * mailing it are different operations with different blast radii, and a
 * script that can do both is one `--apply` away from mailing everybody by
 * accident. When the send is approved it gets its own tool, reviewed on its
 * own.
 *
 * ## Who counts as a recipient
 *
 * Every account, not every workspace owner. The privacy notice governs what
 * Tiny CRM does with a person's data, so a member whose colleague owns the
 * workspace is still a data subject and is still owed the notice. § 12 says
 * "your account address", which is `User.email`.
 *
 * Suspended accounts are included. An operator disabling an account does not
 * end our obligation to tell that person what we do with their data, and they
 * may well sign in again.
 *
 * Addresses are deduplicated: two accounts cannot share one in this schema,
 * but the count is what a send list would be, so it is produced the same way
 * a send list would be.
 *
 * Nothing is printed that identifies anybody. `--sample` shows a handful of
 * addresses with the local part masked, only so the shape can be eyeballed
 * for obvious rubbish (`test@`, `@example.com`) before a real send.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { promptHidden } from "./lib/prompt-hidden.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

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

/** `jane.doe@example.com` -> `j•••@example.com`. */
function mask(email) {
  const [local, domain] = String(email).split("@");
  if (!domain) return "[malformed]";
  return `${local.slice(0, 1)}${"•".repeat(Math.max(2, Math.min(local.length - 1, 5)))}@${domain}`;
}

async function main() {
  const sample = process.argv.includes("--sample");

  console.log("\nPrivacy-notice recipients — count only, nothing is sent");
  console.log("=".repeat(70));

  const url = await promptHidden("Read-only connection string (input hidden): ");
  let fp;
  try { fp = fingerprint(url); } catch { throw new Error("That is not a parseable connection string."); }
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
    const totals = await client.query(`
      SELECT
        count(*)::int                                                         AS accounts,
        count(DISTINCT lower("email"))::int                                   AS distinct_addresses,
        count(*) FILTER (WHERE "deactivatedAt" IS NOT NULL)::int              AS suspended,
        count(*) FILTER (WHERE "emailVerifiedAt" IS NULL)::int                AS unverified,
        count(*) FILTER (WHERE "email" IS NULL OR "email" !~ '^[^@]+@[^@]+\\.[^@]+$')::int AS malformed
      FROM "User"
    `);
    const t = totals.rows[0];

    const byPlan = await client.query(`
      SELECT "plan", count(*)::int AS n FROM "User" GROUP BY "plan" ORDER BY n DESC
    `);
    const subscribers = await client.query(`
      SELECT count(*)::int AS n FROM "User"
       WHERE "billingCustomerId" IS NOT NULL
         AND "planStatus" IN ('active', 'trialing', 'past_due')
    `);
    const domains = await client.query(`
      SELECT split_part(lower("email"), '@', 2) AS domain, count(*)::int AS n
        FROM "User" GROUP BY 1 ORDER BY n DESC LIMIT 8
    `);

    console.log("\n  AUDIENCE");
    console.log(`    accounts                 ${t.accounts}`);
    console.log(`    distinct addresses       ${t.distinct_addresses}   <- the send list`);
    console.log(`    of which suspended       ${t.suspended}   (still owed the notice)`);
    console.log(`    of which unverified      ${t.unverified}`);
    console.log(`    malformed addresses      ${t.malformed}   ${t.malformed > 0 ? "<- FIX BEFORE SENDING" : ""}`);

    console.log("\n  BY STORED PLAN");
    for (const row of byPlan.rows) console.log(`    ${String(row.plan).padEnd(20)} ${row.n}`);

    console.log("\n  CANCELLATION RIGHT (terms § 11)");
    console.log(`    accounts with a live subscription   ${subscribers.rows[0].n}`);
    console.log(`    These are the people the terms give a right to cancel before the`);
    console.log(`    change takes effect, because the privacy notice forms part of the`);
    console.log(`    terms. The email must say so to them.`);

    console.log("\n  TOP DOMAINS (shape check only)");
    for (const row of domains.rows) console.log(`    ${String(row.domain).padEnd(28)} ${row.n}`);

    if (sample) {
      const rows = await client.query(`SELECT "email" FROM "User" ORDER BY "createdAt" LIMIT 5`);
      console.log("\n  SAMPLE (masked)");
      for (const row of rows.rows) console.log(`    ${mask(row.email)}`);
    }

    console.log("\n  Nothing was sent. This script has no send path.\n");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\n${scrub(error?.message ?? error)}\n`);
  process.exit(1);
});
