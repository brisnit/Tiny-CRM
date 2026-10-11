#!/usr/bin/env node
/**
 * The owner-admin panel's production migration, as one reviewed procedure.
 *
 *   node scripts/migrate-admin-panel.mjs            # inspect only
 *   node scripts/migrate-admin-panel.mjs --apply
 *
 * ## Why this is a script and not four commands in a runbook
 *
 * The bare sequence is `use-provider postgresql`, `prisma generate`, `prisma
 * migrate deploy`, `apply-sql`, then `use-provider sqlite` and `generate`
 * again. Every step is implicit about something that matters:
 *
 *   - the provider switch **edits a tracked file**, and an interrupted run
 *     leaves `schema.prisma` on `postgresql`. That has already happened in
 *     this repository, and the next local command fails with an adapter
 *     mismatch that does not name the cause;
 *   - `prisma migrate deploy` reads `DATABASE_URL` from the environment, so a
 *     shell that still has a local one exported applies production migrations
 *     to the wrong database without saying so;
 *   - the SQL policy files are a list maintained in six places, and applying
 *     the wrong subset leaves policies that exist in the repository and not in
 *     the database — which is how six security tests once reported that an
 *     attacker could not do something they could.
 *
 * So the connection is prompted for **hidden**, never read from the
 * environment and never placed in argv where `ps` would show it; the provider
 * is restored in a `finally`; and verification is a read-back rather than an
 * exit code.
 *
 * ## What it does not do
 *
 * It does not bind administration. That is `scripts/bind-platform-admin.mjs`,
 * deliberately separate: applying a schema and granting somebody the ability
 * to suspend accounts are different decisions and should not share a
 * keystroke.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { promptHidden } from "./lib/prompt-hidden.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const ROOT = resolve(import.meta.dirname, "..");
const SCHEMA = resolve(ROOT, "prisma/schema.prisma");

/** Identical to the other production scripts. A host is not a secret. */
const PRODUCTION_FINGERPRINTS = new Map([
  ["18155d6dda02", "production, POOLED endpoint (what the app uses)"],
  ["005bee3e08cc", "production, DIRECT endpoint"],
]);

/** What this release adds. Nothing else is applied. */
const MIGRATION = "20261010035000_platform_admin_and_plan_grants";
const POLICY_FILE = "prisma/postgres/015_platform_admin_policies.sql";

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

function providerIn(source) {
  return /datasource db \{[^}]*provider\s*=\s*"([a-z]+)"/s.exec(source)?.[1] ?? "unknown";
}

/**
 * Runs a command with the connection in the environment, never in argv.
 *
 * Both names are set to the connection that was typed at the prompt.
 * `prisma7.config.ts` resolves its target as `DIRECT_URL || DATABASE_URL`, and
 * it calls `dotenv/config` — so a `DIRECT_URL` left in `.env` or exported in
 * the shell would otherwise decide which database gets migrated, while this
 * script's own verification read the one the operator actually typed. Setting
 * both is what makes the prompt authoritative; it is also what
 * scripts/migrate-production.mjs does, for the same reason.
 */
function run(command, args, url) {
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: url,
      DIRECT_URL: url,
      PRISMA_HIDE_UPDATE_MESSAGE: "1",
    },
  });
}

async function verify(client) {
  const checks = [];

  const migration = await client.query(
    `SELECT "finished_at", "rolled_back_at" FROM "_prisma_migrations"
      WHERE "migration_name" = $1 ORDER BY "started_at"`,
    [MIGRATION],
  );
  const applied = migration.rows.filter((r) => r.finished_at && !r.rolled_back_at);
  checks.push([
    `migration ${MIGRATION} applied exactly once`,
    applied.length === 1,
    `${applied.length} successful rows, ${migration.rows.length} total`,
  ]);

  const tables = await client.query(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname IN ('PlatformAdmin','PlanGrant')`,
  );
  const byName = Object.fromEntries(tables.rows.map((r) => [r.relname, r]));
  checks.push(["PlatformAdmin exists", Boolean(byName.PlatformAdmin), ""]);
  checks.push(["PlanGrant exists", Boolean(byName.PlanGrant), ""]);
  checks.push([
    "PlatformAdmin has RLS enabled and FORCEd",
    Boolean(byName.PlatformAdmin?.relrowsecurity && byName.PlatformAdmin?.relforcerowsecurity),
    "the deny-by-default that stops an ordinary user reading or writing it",
  ]);

  const column = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'User' AND column_name = 'deactivatedReason'`,
  );
  checks.push(["User.deactivatedReason exists", column.rowCount === 1, ""]);

  const policies = await client.query(
    `SELECT tablename, policyname, cmd FROM pg_policies
      WHERE policyname IN ('platform_admin_sees_self','platform_admin_reads')
      ORDER BY tablename, policyname`,
  );
  const names = policies.rows.map((r) => `${r.tablename}.${r.policyname}`);
  for (const expected of [
    "PlatformAdmin.platform_admin_sees_self",
    "Workspace.platform_admin_reads",
    "WorkspaceMember.platform_admin_reads",
  ]) {
    checks.push([`policy ${expected}`, names.includes(expected), ""]);
  }
  checks.push([
    "every admin policy is SELECT-only",
    policies.rows.every((r) => r.cmd === "SELECT"),
    "an admin reads across tenants and writes to none of it",
  ]);
  checks.push([
    "PlatformAdmin has no write policy",
    !policies.rows.some((r) => r.tablename === "PlatformAdmin" && r.cmd !== "SELECT"),
    "administration cannot be granted through the application role",
  ]);

  // The precondition. 015 creates policies whose predicates call app_user_id(),
  // which is created by 002_row_level_security.sql — part of the RLS foundation
  // that every deployed environment already has. Checked rather than assumed,
  // because without it `migrate deploy` succeeds, the migration is *recorded as
  // applied*, and then the policy file fails partway: `PlatformAdmin` is left
  // RLS-enabled and FORCEd with no policy, which is deny-all. That is the safe
  // direction, but it means a release that reads as applied whose panel refuses
  // everyone. Refusing up front is better than recovering from that.
  const foundation = await client.query(
    `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'app_user_id'`,
  );
  const hasFoundation = foundation.rows[0].n > 0;
  checks.push([
    "app_user_id() exists (the RLS foundation 015 builds on)",
    hasFoundation,
    hasFoundation ? "" : "apply prisma/postgres/002_row_level_security.sql first",
  ]);

  const fn = await client.query(
    `SELECT p.prosecdef, p.proconfig FROM pg_proc p
      WHERE p.proname = 'app_is_platform_admin'`,
  );
  checks.push(["app_is_platform_admin() exists", fn.rowCount === 1, ""]);
  checks.push([
    "it is SECURITY DEFINER with a pinned search_path",
    Boolean(fn.rows[0]?.prosecdef) &&
      (fn.rows[0]?.proconfig ?? []).some((c) => c.startsWith("search_path=")),
    String(fn.rows[0]?.proconfig ?? "none"),
  ]);

  // Conditional on the table existing, because this same function runs as the
  // BEFORE pass against a database that has not been migrated yet — where an
  // unguarded `count(*)` raises 42P01 and takes the whole script down before it
  // has inspected, let alone applied, anything.
  const bound = byName.PlatformAdmin
    ? (await client.query(`SELECT count(*)::int AS n FROM "PlatformAdmin"`)).rows[0].n
    : null;
  checks.push([
    "no administrator is bound yet",
    bound === null || bound === 0,
    bound === null
      ? "the table does not exist yet, so nobody can be bound"
      : "binding is a separate, deliberate step",
  ]);

  console.log("\n  VERIFICATION");
  let ok = true;
  for (const [label, passed, detail] of checks) {
    console.log(`    ${passed ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
    if (!passed) ok = false;
  }
  return { ok, hasFoundation };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const before = readFileSync(SCHEMA, "utf8");
  const startingProvider = providerIn(before);

  console.log(`\nOwner-admin panel migration — ${apply ? "APPLY" : "inspect only"}`);
  console.log("=".repeat(70));
  console.log(`  local schema provider  ${startingProvider}`);
  console.log(`  migration              ${MIGRATION}`);
  console.log(`  policy file            ${POLICY_FILE}`);

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
  if (!/005bee3e08cc/.test(fp) && apply) {
    console.log(
      "\n  NOTE: this is the pooled endpoint. Migrations are usually applied\n" +
        "  through the direct one; continue only if you meant to.",
    );
  }

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();
  try {
    console.log("\n--- BEFORE ---");
    const beforeState = await verify(client);

    if (apply && !beforeState.hasFoundation) {
      console.error(
        "\nREFUSED: app_user_id() is not present, so " +
          `${POLICY_FILE} cannot be applied.\n` +
          "  Nothing was written. This database is missing the row-level security\n" +
          "  foundation (prisma/postgres/002_row_level_security.sql); applying the\n" +
          "  migration first would record it as applied and then fail on the\n" +
          "  policies, leaving PlatformAdmin deny-all.\n",
      );
      process.exit(1);
    }

    if (!apply) {
      console.log("\n  Inspect only. Nothing was changed. Re-run with --apply.\n");
      return;
    }

    const answer = await ask('\n  Type "apply" to run the migration and the policy file: ');
    if (answer !== "apply") {
      console.log("\n  Not confirmed. Nothing was changed.\n");
      process.exit(1);
    }

    // The provider switch edits a tracked file. Restored in `finally` whatever
    // happens, because an interrupted run leaving it on postgresql is a trap
    // for the next local command.
    try {
      console.log("\n  Switching the local schema to postgresql…");
      run("node", ["scripts/use-provider.mjs", "postgresql"], url);
      run("npx", ["prisma", "generate"], url);

      console.log("\n  Applying migrations…");
      run("npx", ["prisma", "migrate", "deploy"], url);

      console.log(`\n  Applying ${POLICY_FILE}…`);
      run("node", ["scripts/apply-sql.mjs", POLICY_FILE], url);
    } finally {
      console.log(`\n  Restoring the local schema to ${startingProvider}…`);
      run("node", ["scripts/use-provider.mjs", startingProvider], url);
      run("npx", ["prisma", "generate"], url);
      const restored = providerIn(readFileSync(SCHEMA, "utf8"));
      if (restored !== startingProvider) {
        // Last resort: put the file back byte for byte.
        writeFileSync(SCHEMA, before, "utf8");
        console.log("  (schema restored from the copy taken at start)");
      }
    }

    console.log("\n--- AFTER ---");
    const { ok } = await verify(client);
    if (!ok) {
      console.error("\n  VERIFICATION FAILED. Investigate before binding administration.\n");
      process.exit(1);
    }
    console.log(
      "\n  Done. Nothing is bound yet — the panel is unreachable by everyone.\n" +
        "  Next:  node scripts/resolve-admin-user.mjs <email>\n" +
        "  Then:  node scripts/bind-platform-admin.mjs <user-id>\n",
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\n${scrub(error?.message ?? error)}\n`);
  process.exit(1);
});
