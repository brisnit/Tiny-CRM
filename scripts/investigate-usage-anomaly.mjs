#!/usr/bin/env node
/**
 * Gathers evidence about a usage counter that the metering path could not have
 * produced. Read-only. Deletes nothing, changes nothing.
 *
 * ## Why this is a separate script
 *
 * The audit's job is to answer "can we migrate safely". A counter with an
 * impossible value is a different question — "where did this number come from" —
 * and conflating them tempts exactly the wrong response: deleting the row to make
 * the audit clean. A number you cannot explain is information. Removing it
 * destroys the only evidence of whatever wrote it.
 *
 * ## What counts as evidence
 *
 * A real metered request leaves traces besides the counter: an `AiThread` and its
 * `AiMessage` rows for a chat, an `AiInsight` for a summary or brief. If a counter
 * says 9,999 and the account has no AI artifacts at all, the counter was not
 * produced by use. This script lines those up.
 *
 * It also checks the two ceilings that bound what the application could have
 * written — the plan limit of the era, and the per-user AI rate limit — and
 * reports the arithmetic rather than a conclusion.
 *
 * ## One known synthetic source
 *
 * `tests/integration/ai-enhancement-boundary.test.ts` writes a counter of exactly
 * **9,999** for `ai_requests` in the current period, to prove the UI degrades when
 * an allowance is spent rather than returning a 500. A row with that exact value
 * is almost certainly that fixture, which also implies the database it is in has
 * had the test suite run against it. That is reported, not assumed.
 *
 * Usage:
 *   node scripts/investigate-usage-anomaly.mjs
 *   node scripts/investigate-usage-anomaly.mjs --email=someone@example.com
 */

import { Client } from "pg";

import { promptHidden } from "./lib/prompt-hidden.mjs";

/** Known fixture values, with where they come from. */
const KNOWN_SYNTHETIC = {
  9999: "tests/integration/ai-enhancement-boundary.test.ts writes exactly 9_999 to prove the UI degrades when an allowance is spent",
};

/** AI limits by era, mirroring scripts/plan-usage-audit.mjs. */
const LEGACY_LIMITS = { free: 25, pro: 1000, lifetime: 2000 };
const CURRENT_LIMITS = { free: 10, plus: 30, pro: 60, legacy_pro: 1000, legacy_lifetime: 2000 };

/** The per-user AI rate limit, which bounds how fast a count could ever rise. */
const AI_PER_MINUTE = 20;

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

async function setContext(client, { userId, workspaceIds }) {
  await client.query("SELECT set_config('app.user_id', $1, true)", [userId ?? ""]);
  await client.query("SELECT set_config('app.workspace_ids', $1, true)", [(workspaceIds ?? []).join(",")]);
  await client.query("SELECT set_config('app.restricted_workspace_ids', '', true)");
}

async function main() {
  const onlyEmail = arg("email");

  const connectionString = await promptHidden(
    "Connection string (the application role; input hidden): ",
  );

  const host = (() => {
    try {
      return new URL(connectionString).hostname;
    } catch {
      return "";
    }
  })();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";

  const client = new Client({
    connectionString,
    ssl: loopback ? false : { rejectUnauthorized: true },
    statement_timeout: 30_000,
  });

  await client.connect();
  let open = false;

  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    open = true;

    const who = await client.query("SELECT current_user AS role, current_database() AS db");
    console.log(`\nhost=${host || "?"}  database=${who.rows[0].db}  role=${who.rows[0].role}  READ ONLY\n`);

    // Every counter, so the anomalous ones can be seen in context rather than
    // in isolation.
    const counters = await client.query(
      `SELECT u.id, u."userId", us.email, us.plan, us."createdAt" AS account_created,
              u.period, u.count, u."updatedAt"
         FROM "UsageCounter" u JOIN "User" us ON us.id = u."userId"
        WHERE u.metric = 'ai_requests' ${onlyEmail ? "AND lower(us.email) = lower($1)" : ""}
        ORDER BY u.count DESC`,
      onlyEmail ? [onlyEmail] : [],
    );

    if (counters.rows.length === 0) {
      console.log("No ai_requests counters found.\n");
      return;
    }

    const anomalies = counters.rows.filter((r) => {
      const limits = r.period >= "2026-11" ? CURRENT_LIMITS : LEGACY_LIMITS;
      const limit = limits[r.plan];
      return typeof limit === "number" && r.count > limit + AI_PER_MINUTE;
    });

    console.log(`${counters.rows.length} counter(s); ${anomalies.length} beyond what metering could write.\n`);

    for (const row of anomalies.length > 0 ? anomalies : counters.rows.slice(0, 3)) {
      const limits = row.period >= "2026-11" ? CURRENT_LIMITS : LEGACY_LIMITS;
      const limit = limits[row.plan] ?? null;

      console.log("=".repeat(72));
      console.log(`  account        ${row.email}`);
      console.log(`  plan           ${row.plan}  (era limit ${limit ?? "unknown"})`);
      console.log(`  period         ${row.period}`);
      console.log(`  count          ${row.count}`);
      console.log(`  counter row    ${row.id}`);
      console.log(`  last updated   ${new Date(row.updatedAt).toISOString()}`);
      console.log(`  account made   ${new Date(row.account_created).toISOString()}`);

      if (KNOWN_SYNTHETIC[row.count]) {
        console.log(`\n  MATCHES A KNOWN FIXTURE VALUE:`);
        console.log(`    ${KNOWN_SYNTHETIC[row.count]}`);
        console.log(`    A row with this value implies the test suite has run against this database.`);
      }

      if (typeof limit === "number" && row.count > limit) {
        const minutes = Math.ceil(row.count / AI_PER_MINUTE);
        console.log(`\n  ARITHMETIC`);
        console.log(`    exceeds the era limit by ${row.count - limit}`);
        console.log(`    at the per-user rate limit of ${AI_PER_MINUTE}/min, ${row.count} requests`);
        console.log(`    would need at least ${minutes} minute(s) of sustained maximum traffic`);
        console.log(`    and the metering path refuses once the count reaches the limit`);
      }

      // Corroboration: real use leaves artifacts. Read inside the account's own
      // context, because every one of these tables is under row-level security.
      await setContext(client, { userId: row.userId, workspaceIds: [] });
      const members = await client.query(
        `SELECT m."workspaceId" AS id FROM "WorkspaceMember" m
           JOIN "Workspace" w ON w.id = m."workspaceId"
          WHERE m."userId" = $1`,
        [row.userId],
      );
      const workspaceIds = members.rows.map((r) => r.id);

      let threads = 0;
      let messages = 0;
      let insights = 0;
      if (workspaceIds.length > 0) {
        await setContext(client, { userId: row.userId, workspaceIds });
        threads = (await client.query(
          `SELECT count(*)::int AS n FROM "AiThread" WHERE "workspaceId" = ANY($1)`,
          [workspaceIds],
        ).catch(() => ({ rows: [{ n: "n/a" }] }))).rows[0].n;
        messages = (await client.query(
          `SELECT count(*)::int AS n FROM "AiMessage" WHERE "userId" = $1`,
          [row.userId],
        ).catch(() => ({ rows: [{ n: "n/a" }] }))).rows[0].n;
        insights = (await client.query(
          `SELECT count(*)::int AS n FROM "AiInsight" WHERE "workspaceId" = ANY($1)`,
          [workspaceIds],
        ).catch(() => ({ rows: [{ n: "n/a" }] }))).rows[0].n;
      }

      console.log(`\n  CORROBORATING ARTEFACTS (read in this account's own tenant context)`);
      console.log(`    workspaces     ${workspaceIds.length}`);
      console.log(`    AI threads     ${threads}`);
      console.log(`    AI messages    ${messages}`);
      console.log(`    AI insights    ${insights}`);

      const noTrace = threads === 0 && messages === 0 && insights === 0;
      console.log(
        noTrace
          ? `\n  A count of ${row.count} with no AI artefacts at all is not consistent with use.`
          : `\n  Some AI artefacts exist. Compare their volume against the count before`,
      );
      if (!noTrace) console.log("  concluding either way.");
      console.log("=".repeat(72) + "\n");
    }

    console.log("NOTHING WAS CHANGED. This ran in a read-only transaction.");
    console.log("Before treating any figure as spend, reconcile it against the model");
    console.log("provider's own usage dashboard for the same period — that is the only");
    console.log("record that reflects what was actually billed.\n");
  } finally {
    if (open) await client.query("ROLLBACK");
    await client.end();
  }
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, "postgres://[redacted]");
  console.error(`\nInvestigation failed: ${message}\n`);
  process.exitCode = 1;
});
