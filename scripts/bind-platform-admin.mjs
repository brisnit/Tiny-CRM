#!/usr/bin/env node
/**
 * Binds — or unbinds — the owner-admin panel to one user id.
 *
 *   node scripts/bind-platform-admin.mjs <user-id>
 *   node scripts/bind-platform-admin.mjs --unbind <user-id>
 *
 * This is the only way membership is created. There is no INSERT policy on
 * `PlatformAdmin` for the application role, so the running product cannot
 * grant administration to anybody, including through a bug: the table is
 * written by migration-style operations like this one, connecting as the
 * owner, and read by everything else.
 *
 * Takes an **id**, never an address, for the reason in
 * scripts/resolve-admin-user.mjs. Run that first.
 *
 * The id is the binding, but it is not the only condition: the account it
 * resolves to must be `OWNER_ADMIN_EMAIL`, or this refuses. A mistyped id that
 * happens to name a real customer is the failure that check exists for — see
 * scripts/lib/owner-binding.mjs.
 */
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

import { bindingRefusal, OWNER_ADMIN_EMAIL } from "./lib/owner-binding.mjs";
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

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((done) => {
    let answered = false;
    const finish = (v) => { if (!answered) { answered = true; rl.close(); done(v); } };
    rl.question(question, (a) => finish(a.trim()));
    rl.on("close", () => finish(""));
  });
}

async function report(client) {
  const { rows } = await client.query(
    `SELECT pa."userId", u."email", pa."boundEmail", pa."note", pa."createdAt"
       FROM "PlatformAdmin" pa JOIN "User" u ON u."id" = pa."userId"
      ORDER BY pa."createdAt"`,
  );
  console.log(`\n  PLATFORM ADMINS (${rows.length})`);
  if (rows.length === 0) console.log("    (none — the panel is unreachable by anyone)");
  for (const r of rows) {
    const drift =
      String(r.email).toLowerCase() === String(r.boundEmail).toLowerCase()
        ? ""
        : `  ** BOUND FOR ${r.boundEmail} — the panel will refuse until re-bound **`;
    console.log(`    ${r.email}  ${r.userId}  ${r.note ?? ""}${drift}`);
  }
  return rows;
}

async function main() {
  const unbind = process.argv.includes("--unbind");
  const userId = process.argv.find((a, i) => i >= 2 && !a.startsWith("--"));
  if (!userId) throw new Error("Give the user id. Resolve it with scripts/resolve-admin-user.mjs.");

  console.log(`\n${unbind ? "Unbinding" : "Binding"} platform administration: ${userId}`);
  if (!unbind) console.log(`Only ${OWNER_ADMIN_EMAIL} may be bound; any other account is refused.`);
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
    const before = await report(client);

    const target = await client.query(
      `SELECT "id", "email", "deactivatedAt" FROM "User" WHERE "id" = $1`,
      [userId],
    );
    if (target.rows.length === 0) {
      console.error(`\nREFUSED: no account with id ${userId}.\n`);
      process.exit(1);
    }
    const account = target.rows[0];
    console.log(`\n  target  ${account.email}`);

    // Every refusal rule lives in scripts/lib/owner-binding.mjs, where it can
    // be tested. Chief among them: the account this id resolves to must be
    // OWNER_ADMIN_EMAIL. Confirming by re-typing the address cannot establish
    // that — it only proves the operator can read the line above.
    const refusal = bindingRefusal({ unbind, account, existing: before });
    if (refusal) {
      console.error(`\nREFUSED: ${refusal}\n`);
      process.exit(1);
    }

    const answer = await ask(
      `\n  Type the email to ${unbind ? "UNBIND" : "BIND"} administration: `,
    );
    if (answer.toLowerCase() !== String(account.email).toLowerCase()) {
      console.log("\n  Not confirmed. Nothing was changed.\n");
      process.exit(1);
    }

    if (unbind) {
      await client.query(`DELETE FROM "PlatformAdmin" WHERE "userId" = $1`, [userId]);
    } else {
      // `updatedAt` is not on this table, and `id` has no database default —
      // Prisma's `@default(cuid())` is applied client-side, so raw SQL supplies
      // one. The same lesson the feature-flag script learned the hard way.
      // `boundEmail` is recorded from the account itself, not from anything
      // typed at this prompt: the point of the second condition is to catch a
      // mis-typed id, and an operator-supplied address could agree with the
      // wrong id just as easily as the right one.
      await client.query(
        `INSERT INTO "PlatformAdmin" ("id", "userId", "boundEmail", "note", "createdAt")
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT ("userId") DO UPDATE SET "boundEmail" = $3`,
        [randomUUID(), userId, account.email, "owner"],
      );
    }

    console.log("\n--- AFTER ---");
    const after = await report(client);
    const present = after.some((r) => r.userId === userId);
    if (present === unbind) {
      console.error("\n  VERIFICATION FAILED: the table does not read back as expected.\n");
      process.exit(1);
    }
    console.log(`\n  Verified: ${account.email} ${unbind ? "is no longer" : "is"} a platform admin.`);
    console.log(
      `  Rollback: node scripts/bind-platform-admin.mjs ${unbind ? "" : "--unbind "}${userId}\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\n${scrub(error?.message ?? error)}\n`);
  process.exit(1);
});
