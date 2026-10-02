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

    const who = await client.query(
      "SELECT current_user AS role, current_database() AS db, version() AS version",
    );
    const migrations = await client
      .query('SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')
      .catch(() => ({ rows: [{ n: "unknown" }] }));

    console.log("\nDATABASE IDENTITY");
    console.log(`  host                 ${host || "(unparsed)"}`);
    console.log(`  database             ${who.rows[0].db}`);
    console.log(`  role                 ${who.rows[0].role}`);
    console.log(`  server               ${String(who.rows[0].version).split(" ").slice(0, 2).join(" ")}`);
    console.log(`  migrations applied   ${migrations.rows[0].n}`);
    console.log("  transaction          READ ONLY\n");

    // Reading the wrong database is the failure that makes every number below
    // meaningless while looking entirely plausible, so it is checked rather than
    // assumed. A test database is where fixtures live — including one that writes
    // a UsageCounter of exactly 9,999 to prove the UI degrades when an allowance
    // is spent — so a figure from here can easily be mistaken for real spend.
    const looksLikeTest =
      loopback ||
      /test|dev|local|staging|shadow/i.test(String(who.rows[0].db)) ||
      /localhost|127\.0\.0\.1/.test(host);

    if (looksLikeTest) {
      console.log("!".repeat(72));
      console.log("  THIS DOES NOT LOOK LIKE PRODUCTION.");
      console.log(`  host=${host || "?"} database=${who.rows[0].db}`);
      console.log("  Numbers from a test or local database must not be used to make a");
      console.log("  migration or pricing decision. Stop and reconnect to production.");
      console.log("!".repeat(72) + "\n");
    }

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
    //
    // Reported with enough context to judge whether a figure is real spend.
    //
    // `reserveAiRequest` refuses once the stored count reaches the plan limit, so
    // a count ABOVE that limit cannot have come from the application's metering
    // path. It is then either pre-enforcement data, a direct database write, or a
    // test fixture — and one fixture in this repository writes exactly 9,999 to
    // prove the UI degrades when an allowance is spent
    // (tests/integration/ai-enhancement-boundary.test.ts). A number like that must
    // not be read as provider spend without evidence.
    //
    // UsageCounter is deliberately outside RLS, so these need no context.
    console.log("\nAI REQUESTS (the metered, cost-bearing metric)");

    const aiRows = await client.query(`
      SELECT us.email, us.plan, u.period, u.count, u."updatedAt"
      FROM "UsageCounter" u JOIN "User" us ON us.id = u."userId"
      WHERE u.metric = 'ai_requests'
      ORDER BY u.count DESC
      LIMIT 25
    `);

    if (aiRows.rows.length === 0) {
      console.log("  no AI usage recorded in any period");
    } else {
      /**
       * AI limits by era, because a stored count must be judged against the limits
       * that were in force when it was written.
       *
       * The first version compared every row against *today's* limits and so
       * accused September of anomalies: a Free account with exactly 25 requests had
       * simply used its whole allowance, because Free was 25 then and is 10 now.
       */
      const ERAS = {
        legacy: { label: "pre-pricing", limits: { free: 25, pro: 1000, lifetime: 2000 } },
        current: {
          label: "Free/Plus/Pro",
          limits: { free: 10, plus: 30, pro: 60, legacy_pro: 1000, legacy_lifetime: 2000 },
        },
      };

      /**
       * When the new pricing began serving, as an ISO date — **not** a month.
       *
       * A release lands mid-month, and a monthly counter then spans both eras: a
       * count accumulated under Free 25 before the cutover and Free 10 after can
       * legitimately exceed 10 while being entirely valid. Treating the whole month
       * as "current" would report those as anomalies.
       *
       * The period containing this date is therefore judged by whichever era is
       * more permissive for that plan, and labelled as spanning the cutover. Set it
       * when the pricing release deploys; `null` means it has not, so every period
       * is judged by the pre-pricing limits.
       */
      const NEW_PRICING_EFFECTIVE_AT = null;
      const cutoverPeriod = NEW_PRICING_EFFECTIVE_AT ? NEW_PRICING_EFFECTIVE_AT.slice(0, 7) : null;

      /**
       * Whether overshoot above a limit was bounded in the pre-pricing era.
       *
       * **It was not established, and this script does not claim it was.**
       *
       * The reasoning that it was bounded by the per-user AI rate limit of 20 a
       * minute does not hold. None of src/lib/ai/{summaries,crm-agent,classification}.ts
       * enforces a rate limit itself, and `getRecordSummary` / `getDailyBrief` are
       * called from six server-component page renders — home, projects, deals,
       * opportunities, companies, contacts. A metered request therefore occurred
       * during an ordinary page load with no AI limiter in the path, so concurrency
       * there was bounded by render concurrency, which nothing here measures.
       *
       * So a pre-pricing count above its limit is *possible* under the old
       * non-atomic check-then-increment, but by an unknown amount. Such rows are
       * reported as needing explanation rather than waved through by a tolerance
       * this script cannot justify.
       */
      const LEGACY_OVERSHOOT_BOUND = "unproven";

      const eraFor = (period) => {
        if (!cutoverPeriod) return { era: ERAS.legacy, spans: false };
        if (period < cutoverPeriod) return { era: ERAS.legacy, spans: false };
        if (period > cutoverPeriod) return { era: ERAS.current, spans: false };
        return { era: ERAS.current, spans: true };
      };

      const limitFor = (plan, period) => {
        const { era, spans } = eraFor(period);
        if (!spans) return { limit: era.limits[plan], era, spans };
        // The cutover month: the more permissive of the two, since the counter
        // legitimately accumulated under both.
        const a = ERAS.legacy.limits[plan];
        const b = ERAS.current.limits[plan];
        const candidates = [a, b].filter((v) => typeof v === "number");
        return { limit: candidates.length ? Math.max(...candidates) : undefined, era, spans };
      };

      console.log(
        cutoverPeriod
          ? `  pricing cutover ${NEW_PRICING_EFFECTIVE_AT}; ${cutoverPeriod} spans both eras and is\n` +
              `  judged by the more permissive limit of the two\n`
          : "  the new pricing has not deployed, so every period is judged by the pre-pricing\n" +
              "  limits in force when it was written: Free 25, Pro 1000, Lifetime 2000\n",
      );
      console.log(`  ${"account".padEnd(30)} ${"plan".padEnd(15)} ${"period".padEnd(9)} count  limit  verdict`);

      const verdictFor = (row) => {
        const { limit, era, spans } = limitFor(row.plan, row.period);
        if (typeof limit !== "number") {
          return { limit: null, text: "plan not priced in this era", flag: false };
        }
        if (row.count < limit) return { limit, text: "within the allowance", flag: false };
        if (row.count === limit) return { limit, text: "allowance fully used — valid", flag: false };

        // Above the limit.
        if (era === ERAS.current && !spans) {
          return {
            limit,
            text: "IMPOSSIBLE — reserveAiRequest is atomic and refuses at the limit",
            flag: true,
          };
        }
        return {
          limit,
          text: `over by ${row.count - limit} — possible under the old non-atomic metering, bound ${LEGACY_OVERSHOOT_BOUND}`,
          flag: true,
        };
      };

      for (const r of aiRows.rows) {
        const v = verdictFor(r);
        const { spans } = limitFor(r.plan, r.period);
        console.log(
          `  ${String(r.email).slice(0, 29).padEnd(30)} ${String(r.plan).padEnd(15)} ` +
            `${String(r.period).padEnd(9)} ${String(r.count).padStart(5)}  ${String(v.limit ?? "?").padStart(5)}  ` +
            `${v.text}${spans ? " [spans cutover]" : ""}`,
        );
      }

      const needsExplanation = aiRows.rows.filter((r) => verdictFor(r).flag);
      if (needsExplanation.length > 0) {
        console.log();
        console.log("  " + "!".repeat(70));
        console.log(`  ${needsExplanation.length} row(s) sit above the limit of their era and need explanation.`);
        for (const r of needsExplanation) {
          console.log(`    ${r.email}  ${r.period}  count=${r.count}`);
        }
        console.log();
        console.log("  Pre-pricing metering was a non-atomic check-then-increment, so SOME");
        console.log("  overshoot was possible — but the amount is NOT bounded by anything this");
        console.log("  script can establish. The AI modules enforce no rate limit of their own,");
        console.log("  and summaries and the daily brief ran inside page renders, so concurrency");
        console.log("  there was bounded by render concurrency, not by the per-user AI limit.");
        console.log();
        console.log("  Investigate with scripts/investigate-usage-anomaly.mjs. Do not treat any");
        console.log("  figure as spend without reconciling it against the model provider's own");
        console.log("  usage dashboard for the same period.");
        console.log("  " + "!".repeat(70));
      }
    }

    // ---- 6. Document intelligence footprint ------------------------------
    //
    // Counted inside each account's tenant context, one workspace at a time.
    //
    // The first version of this ran a single query with no context at all and
    // reported zero. `DocumentIngestion` and `DocumentChunk` are FORCE ROW LEVEL
    // SECURITY with a policy requiring app_can_see_workspace on the owning
    // FileAsset, so with no context every row is filtered and the count is zero
    // whatever the database holds. It reported "0 documents" for a deployment that
    // was demonstrably answering questions about a PDF — a false clean, and the
    // same defect this codebase has already recorded three times for feature
    // flags.
    console.log("\nDOCUMENT INTELLIGENCE");

    const everyAccount = await client.query('SELECT id, email FROM "User" ORDER BY "createdAt"');
    const documentsSeen = new Set();
    let chunkTotal = 0;
    const perWorkspace = [];

    for (const account of everyAccount.rows) {
      await setContext(client, { userId: account.id, workspaceIds: [] });
      const members = await client.query(
        `SELECT m."workspaceId" AS id, w.name
           FROM "WorkspaceMember" m JOIN "Workspace" w ON w.id = m."workspaceId"
          WHERE m."userId" = $1 AND w."archivedAt" IS NULL`,
        [account.id],
      );
      const workspaceIds = members.rows.map((r) => r.id);
      if (workspaceIds.length === 0) continue;

      await setContext(client, { userId: account.id, workspaceIds });
      const rows = await client.query(
        `SELECT f."workspaceId" AS ws,
                count(DISTINCT i."fileAssetId")::int AS documents,
                count(c.id)::int AS chunks
           FROM "DocumentIngestion" i
           JOIN "FileAsset" f ON f.id = i."fileAssetId"
           LEFT JOIN "DocumentChunk" c ON c."fileAssetId" = i."fileAssetId"
          WHERE f."workspaceId" = ANY($1)
          GROUP BY f."workspaceId"`,
        [workspaceIds],
      ).catch((error) => {
        console.log(`  (query failed for ${account.email}: ${error.message})`);
        return { rows: [] };
      });

      for (const row of rows.rows) {
        const name = members.rows.find((m) => m.id === row.ws)?.name ?? row.ws;
        if (!perWorkspace.some((w) => w.id === row.ws)) {
          perWorkspace.push({ id: row.ws, name, documents: row.documents, chunks: row.chunks });
        }
      }

      // Distinct ingested files, so a workspace shared by several accounts is not
      // double-counted.
      const ids = await client.query(
        `SELECT DISTINCT i."fileAssetId" AS id
           FROM "DocumentIngestion" i JOIN "FileAsset" f ON f.id = i."fileAssetId"
          WHERE f."workspaceId" = ANY($1)`,
        [workspaceIds],
      ).catch(() => ({ rows: [] }));
      for (const row of ids.rows) documentsSeen.add(row.id);
    }

    for (const w of perWorkspace) {
      console.log(`  ${w.name.padEnd(28)} documents=${w.documents}  chunks=${w.chunks}`);
      chunkTotal += w.chunks;
    }
    console.log(`  TOTAL: ${documentsSeen.size} distinct ingested document(s), ${chunkTotal} chunk(s)`);
    if (documentsSeen.size === 0) {
      console.log("  NOTE: zero here means no account's context revealed an ingested document.");
      console.log("        If a workspace is known to answer questions about a PDF, that is a");
      console.log("        contradiction — check the database identity above before trusting it.");
    }

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
