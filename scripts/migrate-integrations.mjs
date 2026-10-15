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
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Every integration migration that production has not seen, in order.
 *
 * Three, not one. The first version of this script named a single migration
 * — and named it **wrongly**, `20261012031600_integrations_foundation`, which
 * has never existed: the generated directory is `...041600`. It would have
 * reported "0 successful rows" for a migration that had applied perfectly and
 * refused a release that was fine. Checked against the directory listing at
 * startup now, so a name that drifts fails here rather than in the middle of
 * a production run.
 */
const MIGRATIONS = [
  "20261012041600_integrations_foundation",
  "20261012233800_integration_sync_progress",
  "20261013033029_integration_recovery_attempts",
];

/**
 * The policy and function files, in dependency order.
 *
 * 016 creates the privacy policies; its predicates call `app_user_id()` from
 * 002, which is why the foundation is checked before anything is written.
 * 017 creates the scheduler's scan, and 018 **drops 017's signature** and
 * creates the four-argument one — so 017 must precede 018, and applying 018
 * alone would leave `DROP FUNCTION IF EXISTS app_due_integrations(int, int)`
 * dropping nothing and the function missing entirely.
 */
const POLICY_FILES = [
  "prisma/postgres/016_integration_privacy.sql",
  "prisma/postgres/017_due_integrations.sql",
  "prisma/postgres/018_due_integrations_recovery.sql",
];

/** The application role, which the scheduler's function must be callable by. */
const APP_ROLE = "tinycrm_app";

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

  for (const name of MIGRATIONS) {
    const migration = await client.query(
      `SELECT "finished_at", "rolled_back_at" FROM "_prisma_migrations"
        WHERE "migration_name" = $1 ORDER BY "started_at"`,
      [name],
    );
    const applied = migration.rows.filter((r) => r.finished_at && !r.rolled_back_at);
    const unfinished = migration.rows.filter((r) => !r.finished_at && !r.rolled_back_at);
    add(
      `migration ${name} applied exactly once`,
      applied.length === 1,
      `${applied.length} successful, ${unfinished.length} unfinished, ${migration.rows.length} total` +
        (unfinished.length
          ? " — an unfinished row blocks migrate deploy; see scripts/diagnose-migration-state.mjs"
          : ""),
    );
  }

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
                            'syncGeneration','tokenExpiresAt','lastError','disconnectedAt',
                            'importedThrough','backfillTruncated','pagesImported',
                            'recoveryAttempts')`,
  );
  const have = new Set(columns.rows.map((r) => `${r.table_name}.${r.column_name}`));
  for (const expected of [
    "EmailMessage.source", "EmailMessage.visibility", "EmailMessage.ownerUserId",
    "EmailMessage.integrationId", "CalendarEvent.source", "CalendarEvent.visibility",
    "CalendarEvent.ownerUserId", "CalendarEvent.integrationId",
    "Integration.syncGeneration", "Integration.tokenExpiresAt",
    "Integration.lastError", "Integration.disconnectedAt",
    // 20261012233800_integration_sync_progress
    "Integration.importedThrough", "Integration.backfillTruncated",
    "Integration.pagesImported",
    // 20261013033029_integration_recovery_attempts
    "Integration.recoveryAttempts",
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

  // ---- The scheduler's function, and who may call it --------------------
  //
  // Permissions are a separate question from existence, and the one that has
  // already gone wrong: 017 shipped with REVOKE and no GRANT, so the function
  // existed, the migration "succeeded", and every scheduled scan then failed
  // with 42501 — a mailbox that stops syncing with nothing in the schema to
  // show for it. Both halves are checked here.
  const fn = await client.query(
    `SELECT p.prosecdef AS secdef,
            p.proconfig AS config,
            pg_get_function_identity_arguments(p.oid) AS args,
            pg_get_function_result(p.oid) AS result
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'app_due_integrations'`,
  );
  add("app_due_integrations exists exactly once", fn.rowCount === 1,
    fn.rowCount === 1 ? fn.rows[0].args : `${fn.rowCount} overloads — 018 drops 017's signature`);
  if (fn.rowCount === 1) {
    const row = fn.rows[0];
    add("  …takes the four-argument recovery signature", row.args === "p_idle_seconds integer, p_stale_seconds integer, p_max_recovery integer, p_limit integer", row.args);
    add("  …is SECURITY DEFINER", row.secdef === true);
    add("  …has a pinned search_path", (row.config ?? []).some((c) => String(c).startsWith("search_path=")));
    const leaks = ["accountemail", "credentials", "synccursor", "scopes", "lasterror"]
      .filter((c) => String(row.result).toLowerCase().includes(c));
    add("  …returns identifiers only, no customer data", leaks.length === 0, leaks.join(", "));
  }

  const roleExists = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE]);
  add(`the ${APP_ROLE} role exists`, roleExists.rowCount === 1,
    roleExists.rowCount ? "" : "002_row_level_security.sql creates it");

  if (roleExists.rowCount === 1 && fn.rowCount === 1) {
    const grants = await client.query(
      `SELECT has_function_privilege($1, 'app_due_integrations(int,int,int,int)', 'EXECUTE') AS app,
              has_function_privilege('public', 'app_due_integrations(int,int,int,int)', 'EXECUTE') AS pub`,
      [APP_ROLE],
    );
    add(`${APP_ROLE} may execute the scheduler's scan`, grants.rows[0].app === true,
      grants.rows[0].app ? "" : "42501 at every tick: the scan would find nothing, silently");
    add("PUBLIC may NOT execute it", grants.rows[0].pub === false,
      "a SECURITY DEFINER function open to PUBLIC is reachable by every role the database will ever have");
  }

  // The job claim function, which the worker needs for any of this to run at
  // all. Not added by this release — checked because a release that leaves
  // the scheduler callable and the queue unclaimable is still a dead sync.
  const claim = await client.query(
    `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'app_claim_jobs'`,
  );
  add("app_claim_jobs exists (the worker's claim step)", claim.rows[0].n > 0,
    claim.rows[0].n ? "" : "apply prisma/postgres/006_job_claim.sql");

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
  const rehearse = process.argv.includes("--rehearse");
  const before = readFileSync(SCHEMA, "utf8");
  const startingProvider = providerIn(before);

  console.log(
    `\nIntegrations production migration — ${apply ? "APPLY" : "inspect only"}` +
      `${rehearse ? " (REHEARSAL — refuses production)" : ""}`,
  );
  console.log("=".repeat(70));
  console.log(`  local schema provider  ${startingProvider}`);
  for (const name of MIGRATIONS) console.log(`  migration              ${name}`);
  for (const file of POLICY_FILES) console.log(`  policy file            ${file}`);
  console.log(`  deferrability          ${DEFERRABLE_FILE}`);

  // A migration named here that is not on disk would be reported as "not
  // applied" forever and refuse a release that was fine. That is exactly what
  // the previous single-migration constant did: it named
  // 20261012031600_integrations_foundation, which has never existed.
  const onDisk = new Set(
    readdirSync(resolve(ROOT, "prisma/migrations-postgres"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );
  const missing = MIGRATIONS.filter((m) => !onDisk.has(m));
  if (missing.length > 0) {
    console.error(
      `\nREFUSED. These are named here but are not in prisma/migrations-postgres:\n` +
        missing.map((m) => `  ${m}`).join("\n") +
        `\n\nNothing was read or written. Fix the list before running this against anything.\n`,
    );
    process.exit(1);
  }

  const url = await promptHidden("Owner/direct connection string (input hidden): ");
  let fp;
  try {
    fp = fingerprint(url);
  } catch {
    throw new Error("That is not a parseable connection string.");
  }
  const match = PRODUCTION_FINGERPRINTS.get(fp);
  console.log(`\n  fingerprint  ${fp}`);

  // `--rehearse` inverts the guard rather than removing it. The whole point
  // of a rehearsal is that it is NOT production, so a rehearsal pointed at
  // production is the one mistake it must make impossible.
  if (rehearse) {
    if (match) {
      console.error(
        `\nREFUSED. --rehearse is for a scratch database and this is ${match}.\n` +
          `Nothing was read or written.\n`,
      );
      process.exit(1);
    }
    console.log("  identified   not production — rehearsal");
  } else if (!match) {
    console.error("\nREFUSED. Not a known production database. Nothing was read or written.\n");
    process.exit(1);
  } else {
    console.log(`  identified   ${match}`);
  }
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

    // ---- Which ROLE, not just which database --------------------------
    //
    // The fingerprint proves the host and the database name. It says nothing
    // about the role: the owner URL and the application URL for the same Neon
    // branch fingerprint identically. That gap has already cost a release —
    // `migrate deploy` ran `ALTER TABLE "User"` as a role that does not own
    // the table, PostgreSQL refused it with 42501, and the migration was left
    // recorded as started and unfinished. See
    // scripts/diagnose-migration-state.mjs.
    //
    // So the role is established here, before anything is written, by asking
    // whether it owns the tables these migrations alter.
    const who = await client.query(
      `SELECT current_user AS role,
              (SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind = 'r'
                  AND c.relname IN ('Integration','EmailMessage','CalendarEvent')
                  AND pg_get_userbyid(c.relowner) <> current_user) AS not_owned`,
    );
    const { role, not_owned: notOwned } = who.rows[0];
    console.log(`\n  connected as  ${role}`);
    if (notOwned) {
      console.error(
        `\nREFUSED. ${role} does not own: ${notOwned}.\n` +
          `  ALTER TABLE would fail with 42501 partway through, leaving a migration\n` +
          `  recorded as started and unfinished — which then blocks every later\n` +
          `  migrate deploy until it is resolved by hand. Use the OWNER connection\n` +
          `  string. Nothing was written.\n`,
      );
      process.exit(1);
    }
    console.log(`  owns Integration, EmailMessage and CalendarEvent — ALTER will not be refused`);

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

      // The foundation migration adds four foreign keys (ownerUserId and
      // integrationId on EmailMessage and CalendarEvent). 003 is not in the
      // migration history — SQLite has no equivalent — and only affects the
      // keys that exist when it runs, so without re-applying it those four
      // stay non-deferrable and the deployment gate refuses the next
      // production build. That is not hypothetical; it blocked the admin
      // panel release with its migration already applied.
      console.log(`\n  Re-applying ${DEFERRABLE_FILE} (these migrations add foreign keys)…`);
      run("node", ["scripts/apply-sql.mjs", DEFERRABLE_FILE], url);

      for (const file of POLICY_FILES) {
        console.log(`\n  Applying ${file}…`);
        run("node", ["scripts/apply-sql.mjs", file], url);
      }
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
