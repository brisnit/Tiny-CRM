#!/usr/bin/env node
/**
 * Gives existing daily briefs the owner they always had.
 *
 * Before 008, who a brief belonged to lived only inside its composed
 * `entityId`, which is `"<userId>:<comma-joined workspaceIds>"`. This copies
 * that person into the `userId` column so the policy can read it, because a
 * string convention is not something a database boundary should have to parse.
 *
 * Reports before it writes, and reports again afterwards. Rows whose entityId
 * does not resolve to a real user are named, never silently skipped: under 008
 * a brief with no owner is readable by nobody, so an unmapped row is a brief
 * that quietly stops working, and that is worth seeing rather than inferring.
 *
 *   node scripts/backfill-brief-user.mjs            # report only, writes nothing
 *   node scripts/backfill-brief-user.mjs --apply    # perform the backfill
 *
 * Reads DATABASE_URL. It never prints it.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const apply = process.argv.includes("--apply");
const url = process.env.DATABASE_URL;

if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
if (!/^postgres(ql)?:\/\//.test(url)) {
  console.error("This backfill is for PostgreSQL. DATABASE_URL is not a postgres:// URL.");
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();

/** cuids contain no colon, so the owner is everything before the first one. */
const OWNER = `split_part("entityId", ':', 1)`;

try {
  const before = await client.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE "userId" IS NOT NULL)::int AS owned,
           count(*) FILTER (WHERE "userId" IS NULL)::int AS unowned
    FROM "AiInsight" WHERE kind = 'brief'
  `);
  const totals = before.rows[0];
  console.log("brief rows");
  console.log(`  total                  ${totals.total}`);
  console.log(`  already carrying owner ${totals.owned}`);
  console.log(`  to map                 ${totals.unowned}`);

  // Named, not counted: an unmappable row is the interesting case.
  const orphans = await client.query(`
    SELECT i.id, i."entityId", ${OWNER} AS derived
    FROM "AiInsight" i
    WHERE i.kind = 'brief'
      AND i."userId" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = ${OWNER})
    ORDER BY i."createdAt"
  `);
  if (orphans.rowCount > 0) {
    console.log(`\n  ${orphans.rowCount} brief row(s) do not map to a real user:`);
    for (const row of orphans.rows) {
      console.log(`    ${row.id}  entityId=${row.entityId}  derived=${row.derived || "(empty)"}`);
    }
    console.log("  These stay unowned, and under 008 nobody can read them. They regenerate.");
  } else {
    console.log("\n  every unowned brief maps to a real user");
  }

  if (!apply) {
    console.log("\nReport only. Re-run with --apply to write.");
    process.exit(0);
  }

  const updated = await client.query(`
    UPDATE "AiInsight" i
    SET "userId" = ${OWNER}
    WHERE i.kind = 'brief'
      AND i."userId" IS NULL
      AND EXISTS (SELECT 1 FROM "User" u WHERE u.id = ${OWNER})
  `);
  console.log(`\nmapped ${updated.rowCount} brief row(s) to their owner`);

  const after = await client.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE "userId" IS NOT NULL)::int AS owned,
           count(*) FILTER (WHERE "userId" IS NULL)::int AS unowned,
           count(*) FILTER (
             WHERE "userId" IS NOT NULL AND "userId" <> ${OWNER}
           )::int AS mismatched
    FROM "AiInsight" WHERE kind = 'brief'
  `);
  const end = after.rows[0];
  console.log("after");
  console.log(`  total                  ${end.total}   (was ${totals.total})`);
  console.log(`  carrying owner         ${end.owned}`);
  console.log(`  still unowned          ${end.unowned}`);
  console.log(`  owner disagrees with entityId  ${end.mismatched}`);

  if (end.total !== totals.total) {
    console.error("\nFAIL: the number of brief rows changed. Nothing here deletes rows.");
    process.exit(1);
  }
  if (end.mismatched !== 0) {
    console.error("\nFAIL: a row's userId does not match the person named in its entityId.");
    process.exit(1);
  }
  if (end.unowned !== orphans.rowCount) {
    console.error("\nFAIL: rows were left unowned that were expected to map.");
    process.exit(1);
  }
  console.log("\nOK");
} finally {
  await client.end();
}
