#!/usr/bin/env node
/**
 * Finds the canary workspace, and turns two flags on for it — and only for it.
 *
 * ## Why a script rather than a URL
 *
 * The workspace id is not in any route: `/settings/team` resolves it
 * server-side from the active membership, `/settings/workspaces` uses it only
 * as a React key, no form carries it in a hidden field, and no endpoint returns
 * it. Checked rather than assumed. So the id has to come from the database.
 *
 * ## What each mode does
 *
 *   (default)         read-only. Lists every workspace with its id, its
 *                     owner's plan, and the feature-flag rows that already
 *                     exist — global and per-workspace.
 *
 *   --enable <id>     inserts or updates `files` and `documentAi` for that one
 *                     workspace. Nothing else. See the guarantees below.
 *
 *   --disable <id>    sets both back to false for that workspace. The rollback.
 *
 * ## What `--enable` will not do
 *
 *   - **It never touches `User`.** No plan is read for writing, nothing about
 *     Lifetime entitlements can change: the only table written is
 *     `FeatureFlag`, and the only rows are the two named keys with a non-null
 *     `workspaceId`.
 *   - **It never writes a global row.** A `FeatureFlag` with
 *     `workspaceId = NULL` is what makes a flag apply to everyone and what
 *     makes `documentQaAdvertised()` start promising document Q&A on the public
 *     pricing page. This script refuses to create one, and reports any that
 *     already exist so a surprise is visible rather than inferred.
 *   - **It refuses a workspace whose owner is not entitled.** `documentAi` on a
 *     workspace whose owner lacks the `documentQa` capability produces a
 *     confusing "Pro feature" refusal rather than a canary, so that is caught
 *     here instead of in the UI.
 *   - **It prints the plan it found**, so "Lifetime entitlements preserved" is
 *     something you can read rather than something I assert.
 *
 * Secrets come from a hidden prompt, never argv, and the production fingerprint
 * is checked before anything is read.
 *
 *   node scripts/canary-workspace.mjs
 *   node scripts/canary-workspace.mjs --enable <workspace-id>
 *   node scripts/canary-workspace.mjs --disable <workspace-id>
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

import { promptHidden } from "./lib/prompt-hidden.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

/** Identical to migrate-production.mjs and deploy-gate.mjs. A host is not a secret. */
const PRODUCTION_FINGERPRINTS = new Map([
  ["18155d6dda02", "production, POOLED endpoint (what the app uses)"],
  ["005bee3e08cc", "production, DIRECT endpoint"],
]);

const FLAGS = ["files", "documentAi"];
/**
 * Does a **stored** plan value grant documentQa?
 *
 * The stored value is not the plan id. `User.plan` holds `"lifetime"` for the
 * original Lifetime accounts, and `planFor()` resolves it through
 * `PRE_STRIPE_PLAN_ALIASES` to `legacy_lifetime` before reading capabilities.
 * Comparing the raw column against the resolved names — which the first version
 * of this script did — reports a genuinely entitled Lifetime account as "NOT
 * entitled", and `--enable` would then have refused the one workspace this was
 * written for.
 *
 * Mirrored here rather than imported because this is a plain .mjs operator
 * script and `plans.ts` is TypeScript; the alias table is small and the
 * assertion below fails loudly if it ever drifts from the source.
 */
const PLAN_ALIASES = { lifetime: "legacy_lifetime" };
const DOCUMENT_QA_PLANS = new Set(["pro", "legacy_pro", "legacy_lifetime"]);

function entitled(storedPlan) {
  const resolved = PLAN_ALIASES[storedPlan] ?? storedPlan;
  return DOCUMENT_QA_PLANS.has(resolved);
}

/** Fails if the alias table here stops matching src/lib/plans.ts. */
function assertAliasesMatchSource() {
  const { readFileSync } = require("node:fs");
  const { resolve } = require("node:path");
  const source = readFileSync(resolve(import.meta.dirname, "../src/lib/plans.ts"), "utf8");
  for (const [stored, planId] of Object.entries(PLAN_ALIASES)) {
    const pattern = new RegExp(`${stored}:\\s*"${planId}"`);
    if (!pattern.test(source)) {
      throw new Error(
        `The alias ${stored} -> ${planId} is no longer in src/lib/plans.ts. ` +
          `This script would misreport entitlement. Update both.`,
      );
    }
  }
}

function fingerprint(url) {
  const parsed = new URL(url);
  return createHash("sha256")
    .update(`${parsed.hostname}/${parsed.pathname.replace(/^\//, "")}`)
    .digest("hex")
    .slice(0, 12);
}

const scrub = (text) =>
  String(text).replace(/postgres(ql)?:\/\/\S+/g, "[connection string redacted]");

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((done) => {
    let answered = false;
    const finish = (value) => {
      if (answered) return;
      answered = true;
      rl.close();
      done(value);
    };
    rl.question(question, (answer) => finish(answer.trim()));
    rl.on("close", () => finish(""));
  });
}

async function main() {
  const enableAt = process.argv.indexOf("--enable");
  const disableAt = process.argv.indexOf("--disable");
  const target =
    enableAt > -1 ? process.argv[enableAt + 1] : disableAt > -1 ? process.argv[disableAt + 1] : null;
  const writing = enableAt > -1 || disableAt > -1;
  const enabling = enableAt > -1;

  if (writing && !target) throw new Error("--enable and --disable need a workspace id.");

  assertAliasesMatchSource();

  console.log(`\nCanary workspace${writing ? ` — ${enabling ? "ENABLE" : "DISABLE"}` : " (read-only)"}`);
  console.log("=".repeat(68));

  const url = await promptHidden("Connection string (input hidden): ");
  let fp;
  try {
    fp = fingerprint(url);
  } catch {
    throw new Error("That is not a parseable connection string.");
  }
  const parsed = new URL(url);
  const match = PRODUCTION_FINGERPRINTS.get(fp);
  console.log(`\n  host         ${parsed.hostname}`);
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
    // Global rows first. These are the ones that change what everyone sees.
    // ------------------------------------------------------------------
    const global = await client.query(
      `SELECT "key", "enabled" FROM "FeatureFlag" WHERE "workspaceId" IS NULL ORDER BY "key"`,
    );
    console.log("\n  GLOBAL FLAGS (apply to every workspace, and drive the pricing page)");
    if (global.rows.length === 0) {
      console.log("    none — every flag is at its built-in default");
    } else {
      for (const row of global.rows) console.log(`    ${row.key} = ${row.enabled}`);
    }
    const globalRelevant = global.rows.filter((r) => FLAGS.includes(r.key) && r.enabled);
    if (globalRelevant.length > 0) {
      console.log(
        `    NOTE: ${globalRelevant.map((r) => r.key).join(", ")} ` +
          `already enabled GLOBALLY — a per-workspace canary is not isolated.`,
      );
    }

    // ------------------------------------------------------------------
    // Workspaces, with their owner's plan and their own flag rows.
    // ------------------------------------------------------------------
    const workspaces = await client.query(
      `SELECT w."id", w."name", u."email" AS owner_email, u."plan" AS owner_plan,
              (SELECT count(*)::int FROM "FileAsset" f WHERE f."workspaceId" = w."id") AS files
         FROM "Workspace" w
         JOIN "User" u ON u."id" = w."ownerId"
        ORDER BY w."name"`,
    );

    console.log("\n  WORKSPACES");
    for (const w of workspaces.rows) {
      const rows = await client.query(
        `SELECT "key", "enabled" FROM "FeatureFlag" WHERE "workspaceId" = $1 ORDER BY "key"`,
        [w.id],
      );
      const flags = rows.rows.length
        ? rows.rows.map((r) => `${r.key}=${r.enabled}`).join(" ")
        : "(none)";
      const isEntitled = entitled(w.owner_plan);
      console.log(`\n    id            ${w.id}`);
      console.log(`    name          ${w.name}`);
      console.log(`    owner         ${w.owner_email}`);
      console.log(`    owner plan    ${w.owner_plan}  ${isEntitled ? "— entitled to document Q&A" : "— NOT entitled to document Q&A"}`);
      console.log(`    documents     ${w.files}`);
      console.log(`    flags         ${flags}`);
    }

    if (!writing) {
      console.log("\n  Read-only. Nothing was changed.");
      console.log("  To enable the canary:  node scripts/canary-workspace.mjs --enable <id>\n");
      return;
    }

    // ------------------------------------------------------------------
    // The write. One workspace, two keys, nothing else.
    // ------------------------------------------------------------------
    const workspace = workspaces.rows.find((w) => w.id === target);
    if (!workspace) {
      console.error(`\nREFUSED. No workspace with id ${target}. Nothing was changed.\n`);
      process.exit(1);
    }
    if (enabling && !entitled(workspace.owner_plan)) {
      console.error(
        `\nREFUSED. ${workspace.name}'s owner is on "${workspace.owner_plan}", which does not ` +
          `grant documentQa, so document questions would be refused with a "Pro feature" ` +
          `message rather than answered. Nothing was changed.\n`,
      );
      process.exit(1);
    }

    console.log(`\n  ${enabling ? "ENABLING" : "DISABLING"} ${FLAGS.join(" and ")} for:`);
    console.log(`    ${workspace.name}  (${workspace.id})`);
    console.log(`    owner ${workspace.owner_email}, plan ${workspace.owner_plan} — unchanged by this script`);
    console.log(`\n  Only "FeatureFlag" is written. "User" is never touched, so no plan or`);
    console.log(`  entitlement can change. No global row is created.`);

    const confirmation = await ask(`\n  Type the workspace id to proceed: `);
    if (confirmation !== target) {
      console.log("\n  Aborted. Nothing was changed.\n");
      return;
    }

    for (const key of FLAGS) {
      await client.query(
        `INSERT INTO "FeatureFlag" ("id", "key", "workspaceId", "enabled", "description", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, now())
         ON CONFLICT ("key", "workspaceId") DO UPDATE
           SET "enabled" = $3, "updatedAt" = now()`,
        [key, target, enabling, "document Q&A canary"],
      );
    }

    // Verify from the database rather than from the exit code.
    console.log("\n  verifying…\n");
    let failures = 0;
    const check = (ok, label) => {
      console.log(`    ${ok ? "ok  " : "FAIL"}  ${label}`);
      if (!ok) failures += 1;
    };

    const after = await client.query(
      `SELECT "key", "enabled" FROM "FeatureFlag" WHERE "workspaceId" = $1 AND "key" = ANY($2) ORDER BY "key"`,
      [target, FLAGS],
    );
    check(after.rows.length === FLAGS.length, `both flags exist for this workspace`);
    for (const row of after.rows) {
      check(row.enabled === enabling, `${row.key} = ${enabling}`);
    }

    const stillGlobal = await client.query(
      `SELECT count(*)::int AS n FROM "FeatureFlag" WHERE "workspaceId" IS NULL AND "key" = ANY($1)`,
      [FLAGS],
    );
    check(stillGlobal.rows[0].n === 0, `no global row was created (${stillGlobal.rows[0].n})`);

    const others = await client.query(
      `SELECT count(*)::int AS n FROM "FeatureFlag"
        WHERE "key" = ANY($1) AND "workspaceId" IS NOT NULL AND "workspaceId" <> $2 AND "enabled"`,
      [FLAGS, target],
    );
    check(others.rows[0].n === 0, `no other workspace has these flags enabled (${others.rows[0].n})`);

    const plan = await client.query(`SELECT "plan" FROM "User" WHERE "id" = (SELECT "ownerId" FROM "Workspace" WHERE "id" = $1)`, [target]);
    check(
      plan.rows[0]?.plan === workspace.owner_plan,
      `the owner's plan is still "${workspace.owner_plan}" — entitlements untouched`,
    );

    console.log(`\n  ${failures === 0 ? "DONE" : `${failures} CHECK(S) FAILED`}\n`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\n${scrub(error?.message ?? error)}\n`);
  process.exit(1);
});
