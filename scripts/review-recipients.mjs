#!/usr/bin/env node
/**
 * Who on the notice list is a real person, and who is a fixture we created.
 *
 *   node scripts/review-recipients.mjs
 *   node scripts/review-recipients.mjs --full   # every account, not just a summary
 *
 * **Read-only. It deletes nothing, changes nothing and sends nothing.** It
 * produces a proposal for a person to approve, and it is deliberately not
 * wired to anything that acts on its output.
 *
 * ## The question it answers, and the one it refuses to
 *
 * 28 accounts is small enough to read by hand, which is the point: this
 * narrows what a person has to look at and shows its reasoning, rather than
 * deciding. Every exclusion below is a *proposal* with a stated reason, and
 * anything it cannot place confidently goes to AMBIGUOUS for you rather than
 * being quietly dropped.
 *
 * ## What counts as evidence
 *
 * Not "the domain looks fake". A domain heuristic cuts both ways and both
 * ways are bad: it would exclude a real customer at an unusual domain, and it
 * would *include* the seeded demo accounts, which use realistic addresses on
 * purpose. So each account is matched against provenance the code actually
 * creates:
 *
 *   - `tests/helpers/fixtures.ts` mints `<label>-<role>-<n>@test.local`
 *   - `prisma/seed/test-seed.ts` mints `<label>-<role>-<run>@verify.local`
 *   - `prisma/seed/index.ts` creates exactly `owner@tinycrm.app` and
 *     `demo@tinycrm.app`
 *   - `scripts/canary-local.ts` creates `canary@localhost.test`
 *
 * Those are literal, checkable facts about code in this repository, which is
 * why they are quoted in the output beside each decision.
 *
 * ## What is NOT evidence of a fixture
 *
 *   - **An unverified address.** A real person who never clicked the link is
 *     still a data subject and is still owed the notice. Unverified is
 *     reported, never excluded on.
 *   - **No subscription.** The report already shows zero live subscriptions;
 *     everyone is on a free or legacy plan, so billing says nothing here.
 *   - **No recent sign-in.** Dormant is not synthetic.
 *
 * ## Re-run it near the send date
 *
 * Accounts created between now and the send are not in this output. The
 * numbers here are a snapshot and the send must be sized from a fresh run on
 * the day — `scripts/send-notice.ts --live` enforces that separately with
 * `--max`, which refuses if the list has grown past what was approved.
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

/**
 * Provenance rules, each naming the code that mints the address.
 *
 * Ordered: the first match wins, so the exact seed accounts are recognised
 * before any pattern.
 */
const FIXTURE_RULES = [
  {
    id: "seed-demo-owner",
    test: (e) => e === "owner@tinycrm.app",
    why: "created verbatim by prisma/seed/index.ts as the demo owner (Bris Whitaker, legacy_lifetime)",
  },
  {
    id: "seed-demo-free",
    test: (e) => e === "demo@tinycrm.app",
    why: "created verbatim by prisma/seed/index.ts as the free-plan demo account",
  },
  {
    id: "canary-local",
    test: (e) => e === "canary@localhost.test",
    why: "created by scripts/canary-local.ts for the local Outlook canary; refuses to run against anything but SQLite",
  },
  {
    id: "unit-fixture",
    test: (e) => e.endsWith("@test.local"),
    why: "tests/helpers/fixtures.ts mints <label>-<role>-<n>@test.local for every tenant it builds",
  },
  {
    id: "verify-seed",
    test: (e) => e.endsWith("@verify.local"),
    why: "prisma/seed/test-seed.ts mints <label>-<role>-<run>@verify.local",
  },
  {
    id: "reserved-test-tld",
    test: (e) => /@([a-z0-9-]+\.)*(test|invalid|localhost)$/.test(e),
    why: "RFC 2606 reserved TLD — cannot be registered, so no real person can receive mail here",
  },
  {
    id: "example-domain",
    test: (e) => /@([a-z0-9-]+\.)*example\.(com|net|org)$/.test(e),
    why: "RFC 2606 reserved example domain — reserved for documentation, never deliverable",
  },
];

function fingerprint(url) {
  const parsed = new URL(url);
  return createHash("sha256")
    .update(`${parsed.hostname}/${parsed.pathname.replace(/^\//, "")}`)
    .digest("hex")
    .slice(0, 12);
}

const scrub = (t) => String(t).replace(/postgres(ql)?:\/\/\S+/g, "[connection string redacted]");

function classify(row) {
  const email = (row.email ?? "").trim().toLowerCase();
  for (const rule of FIXTURE_RULES) {
    if (rule.test(email)) return { verdict: "EXCLUDE", rule: rule.id, why: rule.why };
  }
  // Nothing in the code mints this address. Look for signs it is nonetheless
  // not a person, and surface them rather than acting on them.
  const signals = [];
  if (!row.last_seen_at) signals.push("never signed in");
  if (row.workspaces === 0) signals.push("owns no workspace");
  if (row.memberships === 0) signals.push("member of nothing");
  if (row.records === 0) signals.push("no CRM records");
  if (signals.length >= 3) {
    return {
      verdict: "AMBIGUOUS",
      rule: "no-provenance-no-activity",
      why: `no code in this repository creates this address, but the account is empty: ${signals.join(", ")}`,
    };
  }
  return { verdict: "INCLUDE", rule: "real", why: "a real address with no fixture provenance" };
}

async function main() {
  const full = process.argv.includes("--full");

  console.log("\nRecipient review — read-only, proposes nothing it can act on");
  console.log("=".repeat(74));

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
  console.log(`  snapshot at  ${new Date().toISOString()}`);

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();
  try {
    const { rows } = await client.query(`
      SELECT u."id", lower(u."email") AS email, u."name", u."plan", u."planStatus",
             u."billingCustomerId", u."emailVerifiedAt" IS NOT NULL AS verified,
             u."deactivatedAt" IS NOT NULL AS suspended,
             u."lastSeenAt" AS last_seen_at, u."createdAt" AS created_at,
             (SELECT count(*)::int FROM "Workspace" w WHERE w."ownerId" = u."id") AS workspaces,
             (SELECT count(*)::int FROM "WorkspaceMember" m WHERE m."userId" = u."id") AS memberships,
             (SELECT count(*)::int FROM "Contact" c
               WHERE c."workspaceId" IN (SELECT w2."id" FROM "Workspace" w2 WHERE w2."ownerId" = u."id")) AS records
        FROM "User" u
       ORDER BY u."createdAt" ASC
    `);

    const buckets = { INCLUDE: [], EXCLUDE: [], AMBIGUOUS: [] };
    for (const row of rows) {
      const verdict = classify(row);
      buckets[verdict.verdict].push({ ...row, ...verdict });
    }

    console.log(`\n  ACCOUNTS  ${rows.length}`);
    console.log(`    proposed INCLUDE     ${String(buckets.INCLUDE.length).padStart(3)}   real people, to be sent the notice`);
    console.log(`    proposed EXCLUDE     ${String(buckets.EXCLUDE.length).padStart(3)}   fixtures, each with code provenance`);
    console.log(`    AMBIGUOUS            ${String(buckets.AMBIGUOUS.length).padStart(3)}   ${buckets.AMBIGUOUS.length ? "YOUR CALL — not excluded by this script" : ""}`);

    console.log("\n  PROPOSED EXCLUSIONS, grouped by the code that creates them");
    const byRule = new Map();
    for (const row of buckets.EXCLUDE) {
      if (!byRule.has(row.rule)) byRule.set(row.rule, { why: row.why, rows: [] });
      byRule.get(row.rule).rows.push(row);
    }
    for (const [rule, group] of byRule) {
      console.log(`\n    ${rule}  (${group.rows.length})`);
      console.log(`      ${group.why}`);
      for (const row of group.rows) console.log(`        ${row.email}`);
    }

    if (buckets.AMBIGUOUS.length) {
      console.log("\n  AMBIGUOUS — decide each of these yourself");
      for (const row of buckets.AMBIGUOUS) {
        console.log(`\n    ${row.email}`);
        console.log(`      ${row.why}`);
        console.log(`      created ${row.created_at.toISOString().slice(0, 10)}, plan ${row.plan}` +
          `, ${row.verified ? "verified" : "UNVERIFIED"}${row.suspended ? ", suspended" : ""}`);
      }
    }

    console.log("\n  PROPOSED RECIPIENTS");
    for (const row of buckets.INCLUDE) {
      const flags = [
        row.verified ? null : "unverified",
        row.suspended ? "suspended" : null,
        row.billingCustomerId ? "has billing customer" : null,
      ].filter(Boolean);
      console.log(`    ${row.email.padEnd(38)} ${row.plan.padEnd(16)} ${flags.join(", ")}`);
    }

    const unverifiedIncluded = buckets.INCLUDE.filter((r) => !r.verified).length;
    console.log("\n  NOT USED AS GROUNDS FOR EXCLUSION");
    console.log(`    unverified addresses among the proposed recipients   ${unverifiedIncluded}`);
    console.log("    A person who never clicked the verification link is still a data");
    console.log("    subject and is still owed the notice. Reported, never excluded on.");
    console.log("    Dormancy and the absence of a subscription are likewise not grounds.");

    if (full) {
      console.log("\n  EVERY ACCOUNT");
      for (const row of rows) {
        const v = classify(row);
        console.log(`    ${v.verdict.padEnd(10)} ${row.email.padEnd(38)} created ${row.created_at.toISOString().slice(0, 10)}`);
      }
    }

    console.log("\n  THIS IS A SNAPSHOT");
    console.log(`    Taken ${new Date().toISOString().slice(0, 10)}. Accounts created between now and`);
    console.log("    the send are not in it. Re-run this on the day, and note that");
    console.log("    send-notice.ts --live refuses when the list has grown past --max.");
    console.log("\n  Nothing was changed. No account was deleted, altered or mailed.\n");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\n${scrub(error?.message ?? error)}\n`);
  process.exit(1);
});
