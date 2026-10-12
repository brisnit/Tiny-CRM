#!/usr/bin/env node
/**
 * Prepares a **local** workspace for the Outlook canary, and prints the
 * browser steps.
 *
 *   npx tsx scripts/canary-local.ts
 *
 * ## Local only, and it refuses to be anything else
 *
 * This writes to the local SQLite development database and enables the
 * `integrations` flag for **one locally created workspace**. It will not run
 * against PostgreSQL and it will not touch the production Artifact Digital
 * workspace: a localhost test has no business enabling a flag for a real
 * tenant, and the flag is per-workspace precisely so it does not have to.
 *
 * Both refusals are checked rather than documented:
 *
 *   - the database URL must be a `file:` SQLite one;
 *   - the flag is written with an explicit `workspaceId`, never the global
 *     `NULL` row, so global integrations stay off.
 *
 * It creates its own account and workspace with a known password, so the
 * canary does not depend on whatever is in the development seed.
 */
import bcrypt from "bcryptjs";

import { db } from "../src/lib/db";
import { env } from "../src/lib/env";

const EMAIL = "canary@localhost.test";
const PASSWORD = "canary-local-password";
const WORKSPACE = "Canary (local)";

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

// Read from the app's own env module rather than from process.env, so this is
// the same URL the application would use — there is no way for the script to
// check one database and the app to open another.
const databaseUrl = env.databaseUrl;
if (!databaseUrl.startsWith("file:")) {
  fail(
    `DATABASE_URL is ${databaseUrl.replace(/:\/\/[^@]*@/, "://[redacted]@")}, which is not a ` +
      `local SQLite database. This script is for a localhost canary only and will not touch a ` +
      `PostgreSQL database — least of all production.`,
  );
}

async function main() {
  try {
    console.log("\nOutlook canary — local setup");
    console.log("=".repeat(70));
    console.log(`  database   ${databaseUrl}`);

    // Credentials must already be present, or the Connect button will render
    // disabled and the browser steps below go nowhere.
    const missing = ["MICROSOFT_CLIENT_ID", "MICROSOFT_TENANT_ID", "MICROSOFT_CLIENT_SECRET"]
      .filter((name) => !process.env[name]);
    if (missing.length > 0) {
      fail(
        `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set in this shell.\n` +
          `They live in .env — run: node scripts/set-microsoft-canary.mjs --check`,
      );
    }
    console.log(`  tenant     ${process.env.MICROSOFT_TENANT_ID}`);

    const user = await db.user.upsert({
      where: { email: EMAIL },
      update: {},
      create: {
        email: EMAIL,
        name: "Canary",
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        emailVerifiedAt: new Date(),
        onboardedAt: new Date(),
        // Pro, because sync is gated at Pro and the canary is not a test of
        // the plan gate.
        plan: "pro",
        updatedAt: new Date(),
      },
      select: { id: true },
    });

    let workspace = await db.workspace.findFirst({
      where: { ownerId: user.id, name: WORKSPACE },
      select: { id: true },
    });
    if (!workspace) {
      // The real provisioning path, so the canary workspace is shaped exactly
      // like a customer's rather than like a hand-built approximation.
      const { provisionWorkspace } = await import("../src/lib/workspaces/provision");
      workspace = await provisionWorkspace(user.id, { name: WORKSPACE });
    }

    // The flag, for THIS workspace only. Never the global row.
    await db.featureFlag.upsert({
      where: { key_workspaceId: { key: "integrations", workspaceId: workspace.id } },
      update: { enabled: true, updatedAt: new Date() },
      create: {
        key: "integrations",
        workspaceId: workspace.id,
        enabled: true,
        updatedAt: new Date(),
      },
    });

    const globalRow = await db.featureFlag.findFirst({
      where: { key: "integrations", workspaceId: null },
      select: { enabled: true },
    });
    const globalOn = globalRow?.enabled === true;

    console.log(`\n  account    ${EMAIL}`);
    console.log(`  password   ${PASSWORD}   (local only, in this script)`);
    console.log(`  workspace  ${WORKSPACE}  (${workspace.id})`);
    console.log(`  flag       integrations = true for that workspace only`);
    console.log(`  global     integrations ${globalOn ? "= TRUE  ** unexpected **" : "is off"}`);
    if (globalOn) {
      fail("The global integrations flag is on. That is not something this script did; stop and investigate.");
    }

    const connections = await db.integration.findMany({
      where: { workspaceId: workspace.id },
      select: { provider: true, status: true, lastSyncAt: true },
    });
    console.log(
      `  existing   ${
        connections.length === 0
          ? "no connections"
          : connections.map((c) => `${c.provider}=${c.status}`).join(", ")
      }`,
    );

    console.log(`
  ──────────────────────────────────────────────────────────────────────
  Next, in one terminal:

      npm run dev

  Then in a browser:

   1. http://localhost:3000/login  →  sign in as ${EMAIL} / ${PASSWORD}
   2. Settings → Integrations
   3. "Outlook email" should show "Not connected" with an enabled Connect
      button. If it says "Unavailable", the credentials are not loaded.
   4. Click Connect. You will be sent to Microsoft, then to GoDaddy's sign-in
      for artifactdigital.co, then to a consent screen listing read access to
      mail and calendar.
   5. Accept. You should land back on Settings with:
         Connected
         hello@artifactdigital.co
         Nothing imported yet — importing has not started.

      That last line is the point: connected is not synced. No message or
      meeting has been imported, because the sync worker does not exist yet.

   6. Verify what was stored, without printing any token:

         npx tsx scripts/canary-local.ts --inspect

   7. Click Disconnect, choose "Keep it", and confirm the badge returns to
      "Not connected".
  ──────────────────────────────────────────────────────────────────────
`);
  } finally {
    await db.$disconnect();
  }
}

async function inspect() {
  try {
    const rows = await db.integration.findMany({
      select: {
        provider: true, status: true, accountEmail: true, scopes: true,
        credentials: true, tokenExpiresAt: true, lastSyncAt: true,
        syncGeneration: true, syncState: true, lastError: true,
      },
    });
    console.log("\nStored connections");
    console.log("=".repeat(70));
    if (rows.length === 0) console.log("  (none)");
    for (const row of rows) {
      // The credential is described, never printed: length and envelope shape
      // are enough to prove it is encrypted.
      const sealed = row.credentials ?? "";
      const encrypted = sealed.startsWith("v1.integration-credentials.");
      console.log(`\n  ${row.provider}`);
      console.log(`    status           ${row.status}`);
      console.log(`    account          ${row.accountEmail ?? "—"}`);
      console.log(`    scopes granted   ${row.scopes ?? "—"}`);
      console.log(`    credential       ${
        sealed ? `${sealed.length} chars, ${encrypted ? "ENCRYPTED (v1 envelope)" : "** NOT ENCRYPTED **"}` : "none"
      }`);
      console.log(`    token expires    ${row.tokenExpiresAt?.toISOString() ?? "—"}`);
      console.log(`    sync generation  ${row.syncGeneration}`);
      console.log(`    sync state       ${row.syncState}`);
      console.log(`    last imported    ${row.lastSyncAt?.toISOString() ?? "never — nothing has been imported"}`);
      console.log(`    last error       ${row.lastError ?? "—"}`);
      if (sealed && !encrypted) {
        fail("A credential is stored unencrypted. Stop and investigate.");
      }
    }
    const counts = {
      emails: await db.emailMessage.count({ where: { source: "imported" } }),
      events: await db.calendarEvent.count({ where: { source: "imported" } }),
    };
    console.log(`\n  imported records   ${counts.emails} messages, ${counts.events} events`);
    console.log(
      `  ${
        counts.emails + counts.events === 0
          ? "Zero, which is correct: connecting does not import, and no sync worker exists yet."
          : "** unexpected — nothing should have imported in this release **"
      }\n`,
    );
  } finally {
    await db.$disconnect();
  }
}

const run = process.argv.includes("--inspect") ? inspect : main;
run().catch((error) => {
  console.error(`\n${String(error?.message ?? error)}\n`);
  process.exit(1);
});
