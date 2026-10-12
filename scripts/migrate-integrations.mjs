#!/usr/bin/env node
/**
 * The integration foundations' production migration, as one reviewed procedure.
 *
 *   node scripts/migrate-integrations.mjs            # inspect only
 *   node scripts/migrate-integrations.mjs --apply
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
 * It does not switch integrations on. The `integrations` feature flag stays
 * off, so no customer can connect anything when this finishes — applying a
 * schema and opening a feature to customers are different decisions and should
 * not share a keystroke. Activation is `scripts/activate-global-flags.mjs`.
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
const MIGRATION = "20261012031600_integrations_foundation";
const POLICY_FILE = "prisma/postgres/016_integration_privacy.sql";

/**
 * Re-applied because this migration adds foreign keys.
 *
 * 003 is not in the migration history — SQLite has no equivalent — and it only
 * affects the foreign keys that exist when it runs. This release adds three
 * (two on PlanGrant, one on PlatformAdmin), so without re-applying it they are
 * non-deferrable and the deployment gate refuses the next production build: a
 * logical restore of a schema with a circular foreign key is impossible
 * without deferrable constraints.
 *
 * That is not hypothetical. It blocked this release's first production build,
 * with the migration already applied. Generic and idempotent — it alters every
 * non-deferrable foreign key in `public` and nothing else.
 */
const DEFERRABLE_FILE = "prisma/postgres/003_deferrable_constraints.sql";

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
  const add = (label, passed, detail = "") => checks.push([label, passed, detail]);

  const migration = await client.query(
    `SELECT "finished_at", "rolled_back_at" FROM "_prisma_migrations"
      WHERE "migration_name" = $1 ORDER BY "started_at"`,
    [MIGRATION],
  );
  const applied = migration.rows.filter((r) => r.finished_at && !r.rolled_back_at);
  add(
    `migration ${MIGRATION} applied exactly once`,
    applied.length === 1,
    `${applied.length} successful rows, ${migration.rows.length} total`,
  );

  // The precondition. 016's policies call app_user_id(), created by
  // 002_row_level_security.sql. Without it `migrate deploy` succeeds, the
  // migration is RECORDED as applied, and the policy file then fails partway —
  // leaving the new columns in place with no privacy policy over them, which is
  // the one intermediate state that is worse than not having started.
  const foundation = await client.query(
    `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'app_user_id'`,
  );
  const hasFoundation = foundation.rows[0].n > 0;
  add(
    "app_user_id() exists (the RLS foundation 016 builds on)",
    hasFoundation,
    hasFoundation ? "" : "apply prisma/postgres/002_row_level_security.sql first",
  );

  // Columns.
  const columns = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('EmailMessage','CalendarEvent','Integration')
        AND column_name IN ('source','visibility','ownerUserId','integrationId',
                            'syncGeneration','tokenExpiresAt','lastError','disconnectedAt')`,
  );
  const have = new Set(columns.rows.map((r) => `${r.table_name}.${r.column_name}`));
  for (const expected of [
    "EmailMessage.source", "EmailMessage.visibility", "EmailMessage.ownerUserId",
    "EmailMessage.integrationId", "CalendarEvent.source", "CalendarEvent.visibility",
    "CalendarEvent.ownerUserId", "CalendarEvent.integrationId",
    "Integration.syncGeneration", "Integration.tokenExpiresAt",
    "Integration.lastError", "Integration.disconnectedAt",
  ]) {
    add(`column ${expected}`, have.has(expected));
  }

  // De-duplication must be workspace-scoped, and the global index must be gone.
  // Both halves: an index that exists alongside the old one is not a fix.
  const indexes = await client.query(
    `SELECT indexname FROM pg_indexes
      WHERE tablename IN ('EmailMessage','CalendarEvent') AND indexdef ILIKE '%UNIQUE%'`,
  );
  const names = new Set(indexes.rows.map((r) => r.indexname));
  for (const table of ["EmailMessage", "CalendarEvent"]) {
    add(
      `${table} de-duplicates per owner within a workspace`,
      names.has(`${table}_workspaceId_ownerUserId_provider_externalId_key`),
    );
    add(
      `${table} no longer has the cross-tenant unique index`,
      !names.has(`${table}_provider_externalId_key`),
      "a global (provider, externalId) index makes a shared item importable by one customer only",
    );
    add(
      `${table} no longer has the workspace-only unique index`,
      !names.has(`${table}_workspaceId_provider_externalId_key`),
      "workspace-only still collides: two colleagues invited to one meeting share the provider's event id",
    );
  }

  // The privacy policies, and that they are RESTRICTIVE. A PERMISSIVE policy
  // with the same predicate would *widen* access, because PostgreSQL ORs them.
  const policies = await client.query(
    `SELECT tablename, policyname, permissive, cmd FROM pg_policies
      WHERE policyname IN ('integration_belongs_to_connector','imported_is_owner_private')
      ORDER BY tablename, policyname`,
  );
  for (const [table, policy] of [
    ["Integration", "integration_belongs_to_connector"],
    ["EmailMessage", "imported_is_owner_private"],
    ["CalendarEvent", "imported_is_owner_private"],
  ]) {
    const row = policies.rows.find((r) => r.tablename === table && r.policyname === policy);
    add(`policy ${table}.${policy}`, Boolean(row));
    add(
      `  …and it is RESTRICTIVE`,
      row?.permissive === "RESTRICTIVE",
      row ? `permissive=${row.permissive}` : "policy absent",
    );
  }

  // RLS still enabled and FORCEd on all three.
  const rls = await client.query(
    `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relnamespace = 'public'::regnamespace
        AND relname IN ('Integration','EmailMessage','CalendarEvent')`,
  );
  for (const table of ["Integration", "EmailMessage", "CalendarEvent"]) {
    const row = rls.rows.find((r) => r.relname === table);
    add(
      `${table} has RLS enabled and FORCEd`,
      Boolean(row?.relrowsecurity && row?.relforcerowsecurity),
    );
  }

  // The deployment gate's own question, asked here so this script fails where
  // the gate would. This migration adds four foreign keys.
  const stragglers = await client.query(
    `SELECT con.conrelid::regclass::text AS tbl, con.conname AS name
       FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
      WHERE con.contype = 'f'
        AND rel.relnamespace = 'public'::regnamespace
        AND NOT con.condeferrable
      ORDER BY 1, 2`,
  );
  add(
    "every foreign key is deferrable (the deployment gate's own check)",
    stragglers.rowCount === 0,
    stragglers.rowCount === 0
      ? ""
      : `${stragglers.rows.map((r) => `${r.tbl}.${r.name}`).join(", ")}`,
  );

  // Nothing stored in clear. There should be no credentials at all yet; if
  // there are, every one of them must look like src/lib/crypto.ts output.
  const creds = await client.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE "credentials" IS NOT NULL)::int AS stored,
            count(*) FILTER (WHERE "credentials" IS NOT NULL
                               AND "credentials" NOT LIKE 'v1.%')::int AS plain
       FROM "Integration"`,
  );
  const { total, stored, plain } = creds.rows[0];
  add(
    "no credential is stored in clear",
    plain === 0,
    `${total} connection row(s), ${stored} with credentials, ${plain} not encrypted`,
  );

  // And the feature stays dark. This script does not open anything to anyone.
  const flag = await client.query(
    `SELECT "enabled" FROM "FeatureFlag" WHERE "key" = 'integrations' AND "workspaceId" IS NULL`,
  );
  add(
    "the integrations flag is not globally on",
    flag.rowCount === 0 || flag.rows[0].enabled === false,
    "activation is a separate, deliberate step",
  );

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

      console.log(`\n  Applying ${DEFERRABLE_FILE} (this migration adds foreign keys)…`);
      run("node", ["scripts/apply-sql.mjs", DEFERRABLE_FILE], url);

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
      "\n  Done. Integrations remain switched off — no customer can connect anything.\n" +
        "  The connectors themselves ship in a later release; this is the schema,\n" +
        "  the privacy policies and the encryption they will need.\n",
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\n${scrub(error?.message ?? error)}\n`);
  process.exit(1);
});
