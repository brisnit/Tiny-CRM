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
 * ## What counts as evidence — three kinds, and they are not equal
 *
 * Not "the domain looks fake". A domain heuristic cuts both ways and both
 * ways are bad: it would exclude a real customer at an unusual domain, and it
 * would *include* the seeded demo accounts, which use realistic addresses on
 * purpose.
 *
 * So every exclusion names its evidence, and the output prints which kind it
 * is, because one of the three is markedly weaker than the others:
 *
 * **`code-provenance`** — a line in this repository mints the address. These
 * are literal, checkable facts about the tree:
 *
 *   - `tests/helpers/fixtures.ts` mints `<label>-<role>-<n>@test.local`
 *   - `prisma/seed/test-seed.ts` mints `<label>-<role>-<run>@verify.local`
 *   - `prisma/seed/index.ts` creates exactly `owner@tinycrm.app` and
 *     `demo@tinycrm.app`
 *   - `scripts/canary-local.ts` creates `canary@localhost.test`
 *
 * **`reserved-by-rfc`** — the domain cannot be registered, so no person can
 * receive mail at it: `.test`, `.invalid`, `.localhost` (RFC 2606, RFC 6762)
 * and `example.com/net/org`.
 *
 * **`operator-history`** — **no code in this repository mints these.** They
 * exist because an operator created them during verification work, and the
 * evidence is that person's account of it plus the shape of the address.
 * `tinycrm-test.local` and the three plus tags are in this class. It is the
 * weakest of the three and is labelled so rather than blended in; an earlier
 * version of this comment claimed every exclusion had code provenance, which
 * was not true once these rules were added.
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
  // ---- Operator history -------------------------------------------------
  //
  // These rest on a DIFFERENT kind of evidence from the rules below, and the
  // difference is worth keeping visible. Nothing in this repository mints
  // these addresses: no script, no fixture, no seed. They exist because an
  // operator created them during verification work, and the evidence is that
  // person's own account of it, corroborated by the shape of the address.
  //
  // That is weaker than pointing at a line of code, so each one is matched
  // exactly rather than by pattern, and anything merely resembling them is
  // sent to AMBIGUOUS instead.
  {
    id: "operator-probe-domain",
    evidence: "operator-history",
    test: (e) => e.endsWith("@tinycrm-test.local"),
    why:
      "operator-created verification accounts. No code in this repository mints " +
      "this domain — the nearest equivalents are perf-regression.ts and " +
      "db-differences.ts, which both use @test.local — so this rests on the " +
      "operator's account of the work, not on provenance in the tree. " +
      ".local is a reserved name (RFC 6762) and cannot receive mail.",
  },
  {
    id: "operator-plus-tag",
    evidence: "operator-history",
    /**
     * An exact allowlist of three confirmed addresses. Not a pattern.
     *
     * This rule has now been wrong twice in opposite directions, and the
     * second mistake is the instructive one.
     *
     * First it listed the bare tags and matched nothing, because it was
     * written from a description of the addresses instead of the addresses.
     * The fix was a pattern — tag from a known set, suffix of eight hex —
     * which matched the three real ones and also, by construction, anything
     * ELSE that happened to fit that shape. Including an address created
     * tomorrow that nobody has confirmed is a test.
     *
     * A pattern in an exclusion rule is a standing instruction to drop
     * future unknowns. These three were confirmed individually by the person
     * who created them, so the rule records exactly those three and nothing
     * else. A fourth will need confirming too, and that is the point rather
     * than an inconvenience: the review loop is cheap and dropping a real
     * customer from a legal notice is not.
     */
    test: (e) =>
      new Set([
        "brisnit+terms-check-32ff0980@gmail.com",
        "brisnit+readiness-892dec8c@gmail.com",
        "brisnit+rc-6aac145f@gmail.com",
      ]).has(e),
    why:
      "three confirmed operator verification accounts, listed by exact address " +
      "including their run suffixes. Gmail routes a plus tag to the same inbox, " +
      "so these are the same person as brisnit@gmail.com, who is on the list in " +
      "their own right — mailing the tags would mean four copies to one human. " +
      "Listed exactly rather than matched by pattern: a bare variant, a " +
      "different suffix, or a new tag of the same shape all go to AMBIGUOUS for " +
      "review rather than being excluded automatically.",
  },

  // ---- Code provenance --------------------------------------------------
  {
    id: "seed-demo-owner",
    evidence: "code-provenance",
    test: (e) => e === "owner@tinycrm.app",
    why: "created verbatim by prisma/seed/index.ts as the demo owner (Bris Whitaker, legacy_lifetime)",
  },
  {
    id: "seed-demo-free",
    evidence: "code-provenance",
    test: (e) => e === "demo@tinycrm.app",
    why: "created verbatim by prisma/seed/index.ts as the free-plan demo account",
  },
  {
    id: "canary-local",
    evidence: "code-provenance",
    test: (e) => e === "canary@localhost.test",
    why: "created by scripts/canary-local.ts for the local Outlook canary; refuses to run against anything but SQLite",
  },
  {
    id: "unit-fixture",
    evidence: "code-provenance",
    test: (e) => e.endsWith("@test.local"),
    why: "tests/helpers/fixtures.ts mints <label>-<role>-<n>@test.local for every tenant it builds",
  },
  {
    id: "verify-seed",
    evidence: "code-provenance",
    test: (e) => e.endsWith("@verify.local"),
    why: "prisma/seed/test-seed.ts mints <label>-<role>-<run>@verify.local",
  },
  {
    id: "reserved-test-tld",
    evidence: "reserved-by-rfc",
    test: (e) => /@([a-z0-9-]+\.)*(test|invalid|localhost)$/.test(e),
    why: "RFC 2606 reserved TLD — cannot be registered, so no real person can receive mail here",
  },
  {
    id: "example-domain",
    evidence: "reserved-by-rfc",
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

/**
 * A populated account is NOT evidence of a real person.
 *
 * An earlier version of this treated emptiness as the signal and, by
 * implication, activity as reassurance. That is backwards for exactly the
 * accounts that matter here: a performance probe creates a workspace and
 * thousands of records, and a timezone probe signs in. Being busy is what a
 * load test looks like.
 *
 * So the rules above run first and win regardless of how much data an account
 * holds, and activity is never used to promote anything to INCLUDE. It is
 * printed beside each account for a human to weigh, and nothing more.
 */
function classify(row) {
  const email = (row.email ?? "").trim().toLowerCase();
  for (const rule of FIXTURE_RULES) {
    if (rule.test(email)) {
      return { verdict: "EXCLUDE", rule: rule.id, why: rule.why, evidence: rule.evidence };
    }
  }

  // A plus tag on an address that is itself on the list means one human would
  // get several copies. Worth a look, never an automatic exclusion: a real
  // customer may legitimately use plus-addressing to sign up.
  const plus = /^([^+@]+)\+([^@]+)@(.+)$/.exec(email);
  if (plus) {
    return {
      verdict: "AMBIGUOUS",
      rule: "plus-tag-not-recognised",
      evidence: "none",
      why:
        `plus-addressed as "${plus[2]}" on ${plus[1]}@${plus[3]}. Not one of the three ` +
        `exact addresses confirmed as operator verification accounts, so it is NOT ` +
        `excluded — even if it resembles them. A bare variant of a known tag, a ` +
        `different suffix, or a new tag all land here on purpose. If ` +
        `${plus[1]}@${plus[3]} is also on the list, one person would receive two ` +
        `copies, which is worth your decision rather than a rule's.`,
    };
  }

  // Nothing matched. Report what the account looks like WITHOUT drawing a
  // conclusion from it in either direction.
  const signals = [];
  if (!row.last_seen_at) signals.push("never signed in");
  if (row.workspaces === 0) signals.push("owns no workspace");
  if (row.memberships === 0) signals.push("member of nothing");
  if (row.records === 0) signals.push("no CRM records");
  if (signals.length === 4) {
    return {
      verdict: "AMBIGUOUS",
      rule: "no-provenance-entirely-empty",
      evidence: "none",
      why:
        `no rule matches this address and the account is entirely empty: ${signals.join(", ")}. ` +
        `Emptiness is a reason to look, not a reason to exclude — a real person who ` +
        `signed up and never returned looks exactly like this.`,
    };
  }
  return {
    verdict: "INCLUDE",
    rule: "real",
    evidence: "none",
    why: "no fixture rule matches this address",
  };
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

    console.log("\n  PROPOSED EXCLUSIONS — the TEST-ACCOUNT REVIEW GROUP");
    console.log("    Grouped by what the evidence actually is. 'code-provenance' points at");
    console.log("    a line in this repository. 'operator-history' rests on the operator's");
    console.log("    account of work they did, corroborated by the address shape — weaker,");
    console.log("    and labelled so you can weigh it differently.");
    const byRule = new Map();
    for (const row of buckets.EXCLUDE) {
      if (!byRule.has(row.rule)) byRule.set(row.rule, { why: row.why, evidence: row.evidence, rows: [] });
      byRule.get(row.rule).rows.push(row);
    }
    for (const [rule, group] of byRule) {
      console.log(`\n    ${rule}  (${group.rows.length})   evidence: ${group.evidence}`);
      console.log(`      ${group.why}`);
      for (const row of group.rows) {
        // Activity is printed, never acted on: a perf probe is busy by design.
        const activity =
          `${row.workspaces}w ${row.memberships}m ${row.records}r` +
          `${row.last_seen_at ? " signed in" : " never signed in"}`;
        console.log(`        ${row.email.padEnd(44)} ${activity}`);
      }
    }
    console.log("\n      Activity counts above are shown, not used. A populated account is");
    console.log("      not evidence of a real person — a performance probe creates a");
    console.log("      workspace and thousands of records, and a timezone probe signs in.");

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

    console.log("\n  HELD IN unless you say otherwise");
    console.log("    Any address on an ordinary consumer or business domain stays in the");
    console.log("    recipient list unless you confirm it is a test. designbysmith@gmail.com");
    console.log("    is in that position: no rule matches it, so it is a recipient.");

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
