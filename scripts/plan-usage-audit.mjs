#!/usr/bin/env node
/**
 * Read-only plan and usage audit.
 *
 * Answers one question before any pricing change ships: **which existing
 * accounts would lose access under the new limits?** Renaming a plan does not
 * preserve entitlements — an account holding `pro` today has unlimited records,
 * and the new Pro ceiling is a finite number. If that number is below what the
 * account already stores, the first thing the account owner meets after the
 * deploy is a refusal.
 *
 * Safety properties, all of them deliberate:
 *
 *   1. **Read-only by the database, not by convention.** Everything runs inside
 *      `BEGIN TRANSACTION READ ONLY` and ends in `ROLLBACK`. A stray write in
 *      this file is refused by PostgreSQL rather than caught in review.
 *   2. **The credential never lands anywhere durable.** It is read from the
 *      terminal with echo off — never from argv (visible in `ps`), never from a
 *      file, never from shell history. It is held in one local and nothing
 *      prints it.
 *   3. **Production RLS semantics, reproduced exactly.** Record counts run
 *      inside the same tenant context the application builds: `app.user_id`
 *      alone to read a user's own memberships (the ground-truth rule in
 *      prisma/postgres/005_identity_policies.sql), then `app.workspace_ids` set
 *      to those workspaces to count. Counting any other way would report
 *      numbers the application cannot see, which is worse than no numbers.
 *   4. **The unprivileged role is enough.** This wants the same connection
 *      string the deployment uses (`tinycrm_app`), not the migration owner. If
 *      it reports zero rows everywhere, that is RLS working, not an empty
 *      database — check you pasted the application credential.
 *
 * Usage:
 *   node scripts/plan-usage-audit.mjs
 *
 * It prompts for the connection string. Nothing else is required.
 */

import { Client } from "pg";
import { promptHidden } from "./lib/prompt-hidden.mjs";

/**
 * Provisional ceilings for the Free / Plus / Pro rewrite. Kept here so the
 * audit states plainly what it is measuring against; the real source of truth
 * after the rewrite is src/lib/plans.ts.
 */
const PROPOSED = {
  free: { contacts: 100, companies: 50, deals: 25, projects: 5, opportunities: 10, tasks: 200, customFields: 3, workspaces: 1 },
  plus: { contacts: 2000, companies: 750, deals: 400, projects: 75, opportunities: 200, tasks: 4000, customFields: 20, workspaces: 3 },
  pro: { contacts: 5000, companies: 2000, deals: 1200, projects: 200, opportunities: 600, tasks: 10000, customFields: 50, workspaces: 10 },
};

/** Where each stored plan is headed, for the over-limit comparison. */
const PROPOSED_MAPPING = {
  free: "free",
  pro: "pro",
  lifetime: "pro",
};


/** Sets the tenant context for the statements that follow, inside this transaction. */
async function setContext(client, { userId, workspaceIds }) {
  await client.query("SELECT set_config('app.user_id', $1, true)", [userId ?? ""]);
  await client.query("SELECT set_config('app.workspace_ids', $1, true)", [(workspaceIds ?? []).join(",")]);
  // Empty means "restrict nothing". The audit counts what the workspace holds,
  // which is what a plan limit is measured against — not what one member may
  // see. src/lib/entitlements.ts makes the same choice for the same reason.
  await client.query("SELECT set_config('app.restricted_workspace_ids', '', true)");
}

const COUNTED = [
  ["contacts", 'SELECT count(*)::int AS n FROM "Contact" WHERE "workspaceId" = ANY($1) AND "archivedAt" IS NULL'],
  ["companies", 'SELECT count(*)::int AS n FROM "Company" WHERE "workspaceId" = ANY($1) AND "archivedAt" IS NULL'],
  ["deals", 'SELECT count(*)::int AS n FROM "Deal" WHERE "workspaceId" = ANY($1) AND "archivedAt" IS NULL'],
  ["projects", 'SELECT count(*)::int AS n FROM "Project" WHERE "workspaceId" = ANY($1) AND "archivedAt" IS NULL'],
  ["opportunities", 'SELECT count(*)::int AS n FROM "Opportunity" WHERE "workspaceId" = ANY($1) AND "archivedAt" IS NULL'],
  ["tasks", 'SELECT count(*)::int AS n FROM "Task" WHERE "workspaceId" = ANY($1) AND "archivedAt" IS NULL'],
  ["customFields", 'SELECT count(*)::int AS n FROM "CustomFieldDef" WHERE "workspaceId" = ANY($1)'],
];

async function main() {
  const connectionString = await promptHidden(
    "Production connection string (the application role; input hidden): ",
  );

  // TLS is required for anything that is not plainly a loopback address, with
  // certificate verification on. A managed provider always presents a valid
  // certificate, so there is no reason to accept an unverified one — and
  // `sslmode` in the URL is not relied on, because a URL that happens to omit
  // it would otherwise connect to production in the clear.
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
  let opened = false;

  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    opened = true;

    const who = await client.query("SELECT current_user AS role, current_database() AS db");
    console.log(`\nConnected as ${who.rows[0].role} to ${who.rows[0].db} (read-only transaction)\n`);

    // ---- 1. Plan distribution -------------------------------------------
    const dist = await client.query(`
      SELECT plan, "planStatus", count(*)::int AS accounts
      FROM "User"
      GROUP BY plan, "planStatus"
      ORDER BY accounts DESC, plan
    `);
    console.log("PLAN DISTRIBUTION");
    if (dist.rows.length === 0) console.log("  (no user rows)");
    for (const r of dist.rows) {
      console.log(`  ${String(r.plan).padEnd(10)} status=${String(r.planStatus).padEnd(10)} ${r.accounts} account(s)`);
    }

    // ---- 2. Anyone who has ever been billed -----------------------------
    const billed = await client.query(`
      SELECT count(*)::int AS n FROM "User" WHERE "billingCustomerId" IS NOT NULL
    `);
    console.log(`\nAccounts carrying a billing customer id: ${billed.rows[0].n}`);
    console.log("  (zero confirms no processor has ever charged anyone)");

    // ---- 3. Every non-free account, in detail ---------------------------
    const accounts = await client.query(`
      SELECT id, email, name, plan, "planStatus", "planRenewsAt",
             "billingCustomerId" IS NOT NULL AS has_customer,
             "createdAt", "deactivatedAt"
      FROM "User"
      WHERE plan <> 'free' OR "planStatus" <> 'active'
      ORDER BY plan, "createdAt"
    `);

    console.log(`\nNON-FREE OR NON-ACTIVE ACCOUNTS: ${accounts.rows.length}`);

    const findings = [];

    for (const account of accounts.rows) {
      // Memberships first, with the user alone in context — the one lookup
      // that cannot consult a context because it produces one.
      await setContext(client, { userId: account.id, workspaceIds: [] });
      const members = await client.query(
        `SELECT m."workspaceId" AS id, w.name
           FROM "WorkspaceMember" m
           JOIN "Workspace" w ON w.id = m."workspaceId"
          WHERE m."userId" = $1 AND w."archivedAt" IS NULL`,
        [account.id],
      );
      const workspaceIds = members.rows.map((r) => r.id);

      const usage = { workspaces: workspaceIds.length };
      if (workspaceIds.length > 0) {
        await setContext(client, { userId: account.id, workspaceIds });
        for (const [key, sql] of COUNTED) {
          const res = await client.query(sql, [workspaceIds]);
          usage[key] = res.rows[0].n;
        }
      } else {
        for (const [key] of COUNTED) usage[key] = 0;
      }

      // Seats: the largest member count across workspaces this account owns,
      // because seats-per-workspace follow the owner's plan.
      await setContext(client, { userId: account.id, workspaceIds });
      const seats = workspaceIds.length
        ? await client.query(
            `SELECT w.id, w.name, count(m.id)::int AS members
               FROM "Workspace" w
               LEFT JOIN "WorkspaceMember" m ON m."workspaceId" = w.id
              WHERE w.id = ANY($1) AND w."ownerId" = $2
              GROUP BY w.id, w.name
              ORDER BY members DESC`,
            [workspaceIds, account.id],
          )
        : { rows: [] };

      const target = PROPOSED_MAPPING[account.plan] ?? "free";
      const ceilings = PROPOSED[target];
      const breaches = [];
      for (const key of Object.keys(ceilings)) {
        const used = usage[key] ?? 0;
        if (used > ceilings[key]) breaches.push(`${key}: ${used} > ${ceilings[key]}`);
      }
      const seatBreaches = seats.rows.filter((w) => w.members > (target === "free" ? 1 : target === "plus" ? 3 : 10));

      console.log(`\n  ${account.email}`);
      console.log(`    plan=${account.plan} status=${account.planStatus} customer=${account.has_customer} created=${new Date(account.createdAt).toISOString().slice(0, 10)}`);
      console.log(`    workspaces: ${workspaceIds.length}${members.rows.length ? ` (${members.rows.map((r) => r.name).join(", ")})` : ""}`);
      console.log(`    records: ${COUNTED.map(([k]) => `${k}=${usage[k]}`).join("  ")}`);
      if (seats.rows.length) {
        console.log(`    owned workspace member counts: ${seats.rows.map((w) => `${w.name}=${w.members}`).join("  ")}`);
      }
      console.log(`    would map to: ${target}`);
      if (breaches.length === 0 && seatBreaches.length === 0) {
        console.log(`    VERDICT: fits within proposed ${target} limits`);
      } else {
        console.log(`    VERDICT: WOULD LOSE ACCESS — ${[...breaches, ...seatBreaches.map((w) => `seats in ${w.name}: ${w.members}`)].join("; ")}`);
        findings.push({ email: account.email, plan: account.plan, target, breaches: [...breaches, ...seatBreaches.map((w) => `seats in ${w.name}: ${w.members}`)] });
      }
    }

    // ---- 4. Free accounts that would breach the new free ceilings --------
    // The free limits move too (contacts 50 -> 100 and so on), so this is
    // looking for accounts already above the *new* numbers, not the old ones.
    const freeAccounts = await client.query(`
      SELECT id, email FROM "User" WHERE plan = 'free' AND "planStatus" = 'active' ORDER BY "createdAt"
    `);
    console.log(`\nFREE ACCOUNTS: ${freeAccounts.rows.length} — checking against proposed free ceilings`);

    // Only breaches and the busiest handful are printed. An exhaustive listing
    // buries the two lines that matter under every dormant signup.
    let freeFitting = 0;
    const freeRanked = [];

    for (const account of freeAccounts.rows) {
      await setContext(client, { userId: account.id, workspaceIds: [] });
      const members = await client.query(
        `SELECT m."workspaceId" AS id FROM "WorkspaceMember" m
           JOIN "Workspace" w ON w.id = m."workspaceId"
          WHERE m."userId" = $1 AND w."archivedAt" IS NULL`,
        [account.id],
      );
      const workspaceIds = members.rows.map((r) => r.id);
      const usage = { workspaces: workspaceIds.length };
      if (workspaceIds.length) {
        await setContext(client, { userId: account.id, workspaceIds });
        for (const [key, sql] of COUNTED) {
          const res = await client.query(sql, [workspaceIds]);
          usage[key] = res.rows[0].n;
        }
      } else {
        for (const [key] of COUNTED) usage[key] = 0;
      }

      const breaches = Object.keys(PROPOSED.free).filter((k) => (usage[k] ?? 0) > PROPOSED.free[k]);
      // "Fullness" is the worst ratio against any one ceiling, which is what
      // decides whether an account is about to meet a refusal.
      const fullness = Math.max(
        ...Object.keys(PROPOSED.free).map((k) => (usage[k] ?? 0) / PROPOSED.free[k]),
      );
      freeRanked.push({ email: account.email, usage, fullness });

      if (breaches.length) {
        console.log(`  OVER  ${account.email}: ${breaches.map((k) => `${k} ${usage[k]}>${PROPOSED.free[k]}`).join(", ")}`);
        findings.push({ email: account.email, plan: "free", target: "free", breaches: breaches.map((k) => `${k}: ${usage[k]} > ${PROPOSED.free[k]}`) });
      } else {
        freeFitting += 1;
      }
    }

    console.log(`  ${freeFitting} free account(s) fit within the proposed ceilings.`);
    const busiest = freeRanked.sort((a, b) => b.fullness - a.fullness).slice(0, 5).filter((r) => r.fullness > 0);
    if (busiest.length) {
      console.log("  closest to a ceiling:");
      for (const r of busiest) {
        console.log(
          `    ${r.email} (${Math.round(r.fullness * 100)}% of its tightest limit) ` +
            `${COUNTED.map(([k]) => `${k}=${r.usage[k]}`).join(" ")} workspaces=${r.usage.workspaces}`,
        );
      }
    }

    // ---- 5. AI usage, the cost-bearing metric ---------------------------
    const ai = await client.query(`
      SELECT u.period, count(*)::int AS accounts, sum(u.count)::int AS requests,
             max(u.count)::int AS busiest_account
      FROM "UsageCounter" u
      WHERE u.metric = 'ai_requests'
      GROUP BY u.period
      ORDER BY u.period DESC
      LIMIT 6
    `);
    console.log("\nAI REQUESTS BY PERIOD (the metered metric)");
    if (ai.rows.length === 0) console.log("  (no AI usage recorded — consistent with the provider resolving to the built-in engine)");
    for (const r of ai.rows) {
      console.log(`  ${r.period}: ${r.requests} request(s) across ${r.accounts} account(s), busiest=${r.busiest_account}`);
    }

    const aiTop = await client.query(`
      SELECT us.email, u.period, u.count
      FROM "UsageCounter" u JOIN "User" us ON us.id = u."userId"
      WHERE u.metric = 'ai_requests'
      ORDER BY u.count DESC
      LIMIT 10
    `);
    if (aiTop.rows.length) {
      console.log("  heaviest account-periods:");
      for (const r of aiTop.rows) console.log(`    ${r.email} ${r.period}: ${r.count}`);
    }

    // ---- 6. Document intelligence footprint ------------------------------
    // Pro's differentiator. Worth knowing how much is already ingested.
    const docs = await client.query(`
      SELECT count(DISTINCT i."fileAssetId")::int AS documents,
             count(c.id)::int AS chunks
      FROM "DocumentIngestion" i
      LEFT JOIN "DocumentChunk" c ON c."fileAssetId" = i."fileAssetId"
    `).catch(() => ({ rows: [{ documents: "n/a", chunks: "n/a" }] }));
    console.log(`\nDocument intelligence: ${docs.rows[0].documents} ingested document(s), ${docs.rows[0].chunks} chunk(s)`);

    // ---- Summary ---------------------------------------------------------
    console.log("\n" + "=".repeat(72));
    if (findings.length === 0) {
      console.log("RESULT: no account would lose access under the proposed limits.");
    } else {
      console.log(`RESULT: ${findings.length} account(s) would lose access. Each needs a decision:`);
      for (const f of findings) {
        console.log(`  ${f.email} (${f.plan} -> ${f.target}): ${f.breaches.join("; ")}`);
      }
    }
    console.log("=".repeat(72) + "\n");
  } finally {
    if (opened) await client.query("ROLLBACK");
    await client.end();
  }
}

main().catch((error) => {
  // Never echo the connection string, which may appear in a driver error.
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, "postgres://[redacted]");
  console.error(`\nAudit failed: ${message}\n`);
  process.exitCode = 1;
});
