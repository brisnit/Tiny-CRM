#!/usr/bin/env node
/**
 * Turns a feature on for **everyone**, by writing the global `FeatureFlag` row.
 *
 * Flag resolution is workspace row -> global row -> built-in default, so this
 * is the switch that changes what every workspace without an override sees.
 * `scripts/canary-workspace.mjs` deliberately refuses to write one; this is the
 * script that does, and it is separate so that enabling one workspace and
 * enabling the world can never be the same keystroke.
 *
 *   node scripts/activate-global-flags.mjs                 # report only
 *   node scripts/activate-global-flags.mjs --enable files
 *   node scripts/activate-global-flags.mjs --enable documentAi
 *   node scripts/activate-global-flags.mjs --disable files        # rollback
 *
 * ## What it will not do
 *
 *   - **It never touches a workspace row.** Artifact Digital's overrides stay
 *     exactly as they are; a workspace `true` over a global `true` is a no-op,
 *     and removing them is a separate decision with risk and no benefit.
 *   - **It never changes a plan, a capability or a built-in default.**
 *     Activation is data. `FLAGS.documentAi.default` stays `false` in source,
 *     which `tests/unit/pricing-copy.test.ts` asserts on purpose, and a row is
 *     reversible in seconds with no deploy.
 *   - **One flag per run.** `files` and `documentAi` are separate steps with
 *     separate verification, and batching them would skip the middle state.
 *
 * ## What enabling `documentAi` also does
 *
 * It starts advertising. `advertisedFeatures` adds the Pro-only line "Ask
 * questions about an uploaded PDF, answered from that document with page
 * citations" to the public pricing page, because `documentQaAdvertised()` reads
 * this same global row. Advertising and enabling move together by design — so
 * this is not only a capability change, it is a change to what the product
 * promises.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

import { promptHidden } from "./lib/prompt-hidden.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

/** Identical to migrate-production.mjs and canary-workspace.mjs. A host is not a secret. */
const PRODUCTION_FINGERPRINTS = new Map([
  ["18155d6dda02", "production, POOLED endpoint (what the app uses)"],
  ["005bee3e08cc", "production, DIRECT endpoint"],
]);

/** Only these two. Nothing here should be able to flip `ai`, or anything else. */
const ACTIVATABLE = new Set(["files", "documentAi"]);
const REPORTED = ["files", "ai", "documentAi"];

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

async function report(client) {
  console.log("\n  GLOBAL ROWS (workspaceId IS NULL)");
  const global = await client.query(
    `SELECT "key", "enabled" FROM "FeatureFlag" WHERE "workspaceId" IS NULL ORDER BY "key"`,
  );
  if (global.rows.length === 0) console.log("    (none — every workspace sees the built-in default)");
  for (const row of global.rows) console.log(`    ${row.key.padEnd(14)} = ${row.enabled}`);

  console.log("\n  WORKSPACE OVERRIDES for files / ai / documentAi");
  const overrides = await client.query(
    `SELECT f."key", f."enabled", w."name", w."id"
       FROM "FeatureFlag" f JOIN "Workspace" w ON w."id" = f."workspaceId"
      WHERE f."key" = ANY($1)
      ORDER BY w."name", f."key"`,
    [REPORTED],
  );
  if (overrides.rows.length === 0) console.log("    (none)");
  for (const row of overrides.rows) {
    console.log(`    ${row.name} — ${row.key} = ${row.enabled}  (${row.id})`);
  }

  console.log("\n  BLAST RADIUS — workspaces by owner plan");
  const plans = await client.query(
    `SELECT u."plan" AS plan, count(*)::int AS workspaces
       FROM "Workspace" w JOIN "User" u ON u."id" = w."ownerId"
      GROUP BY u."plan" ORDER BY workspaces DESC`,
  );
  for (const row of plans.rows) console.log(`    ${String(row.plan).padEnd(18)} ${row.workspaces}`);
  const total = plans.rows.reduce((sum, r) => sum + r.workspaces, 0);
  console.log(`    ${"TOTAL".padEnd(18)} ${total}`);
  return global.rows;
}

async function main() {
  const enableAt = process.argv.indexOf("--enable");
  const disableAt = process.argv.indexOf("--disable");
  const key =
    enableAt > -1 ? process.argv[enableAt + 1] : disableAt > -1 ? process.argv[disableAt + 1] : null;
  const writing = enableAt > -1 || disableAt > -1;
  const enabling = enableAt > -1;

  if (enableAt > -1 && disableAt > -1) throw new Error("Pick one of --enable or --disable.");
  if (writing && !key) throw new Error("--enable and --disable need a flag name.");
  if (writing && !ACTIVATABLE.has(key)) {
    throw new Error(`Refusing: "${key}" is not one of ${[...ACTIVATABLE].join(", ")}.`);
  }

  console.log(`\nGlobal feature flags${writing ? ` — ${enabling ? "ENABLE" : "DISABLE"} ${key}` : " — report only"}`);
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
    console.error("\nREFUSED. Not a known production database. Nothing was read or written.\n");
    process.exit(1);
  }
  console.log(`  identified   ${match}`);

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();
  try {
    console.log("\n--- BEFORE ---");
    await report(client);

    if (!writing) {
      console.log("\n  Read-only. Nothing was changed.\n");
      return;
    }

    if (enabling && key === "documentAi") {
      console.log(
        "\n  NOTE: enabling documentAi also starts ADVERTISING it. The public\n" +
          "  pricing page gains a Pro-only line promising document questions with\n" +
          "  page citations, because the same global row drives both.",
      );
    }

    const answer = await ask(
      `\n  Type the flag name to ${enabling ? "enable" : "disable"} it for every workspace: `,
    );
    if (answer !== key) {
      console.log("\n  Not confirmed. Nothing was changed.\n");
      process.exit(1);
    }

    // Two things about this table that a generic upsert gets wrong.
    //
    // `updatedAt` is `TIMESTAMP(3) NOT NULL` with **no database default**:
    // Prisma's `@updatedAt` is applied by the client, so raw SQL has to supply
    // it. Omitting it is not a silent nullable — it fails the not-null
    // constraint, which is exactly how the first attempt at this died.
    //
    // And `ON CONFLICT ("key", "workspaceId")` cannot be used for the global
    // row. The unique index is over `(key, workspaceId)`, and in a plain
    // unique index NULLs are *distinct* — so `(files, NULL)` does not conflict
    // with `(files, NULL)` and the upsert would insert a duplicate rather than
    // update. scripts/canary-workspace.mjs may use ON CONFLICT safely because
    // it only ever writes rows with a real workspace id. This one must not.
    //
    // Hence update-then-insert, and the duplicate check above it: without a
    // usable unique constraint, nothing but this stops two global rows for one
    // key, and flag resolution would then depend on which came back first.
    const existing = await client.query(
      `SELECT "id", "enabled" FROM "FeatureFlag" WHERE "key" = $1 AND "workspaceId" IS NULL`,
      [key],
    );
    if (existing.rows.length > 1) {
      console.error(
        `\n  REFUSED: ${existing.rows.length} global rows already exist for "${key}". ` +
          `Flag resolution would be ambiguous. Resolve by hand before activating.\n`,
      );
      process.exit(1);
    }

    if (existing.rows.length === 1) {
      const updated = await client.query(
        `UPDATE "FeatureFlag" SET "enabled" = $2, "updatedAt" = now()
          WHERE "key" = $1 AND "workspaceId" IS NULL`,
        [key, enabling],
      );
      console.log(`\n  Updated ${updated.rowCount} global row: ${key} = ${enabling}.`);
    } else {
      await client.query(
        `INSERT INTO "FeatureFlag" ("id", "key", "enabled", "workspaceId", "description", "updatedAt")
         VALUES (gen_random_uuid()::text, $1, $2, NULL, $3, now())`,
        [key, enabling, "global activation"],
      );
      console.log(`\n  Inserted global row ${key} = ${enabling}.`);
    }

    console.log("\n--- AFTER ---");
    const after = await report(client);
    const row = after.find((r) => r.key === key);
    if (!row || row.enabled !== enabling) {
      console.error("\n  VERIFICATION FAILED: the global row does not read back as set.\n");
      process.exit(1);
    }
    console.log(`\n  Verified: global ${key} = ${row.enabled}.`);
    console.log(`  Rollback: node scripts/activate-global-flags.mjs --disable ${key}\n`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\n${scrub(error?.message ?? error)}\n`);
  process.exit(1);
});
