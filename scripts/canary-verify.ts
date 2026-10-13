/**
 * Verifies the three things a stored connection has to get right, against the
 * **real** canary connection in the local database.
 *
 *   npx tsx scripts/canary-verify.ts --encryption
 *   npx tsx scripts/canary-verify.ts --refresh      # contacts Microsoft
 *   npx tsx scripts/canary-verify.ts --disconnect   # ends the connection
 *
 * ## What is real here and what is not
 *
 * `--encryption` and `--disconnect` are entirely local. **`--refresh` makes a
 * real request to Microsoft's token endpoint** using the stored refresh token,
 * because that is the only way to find out whether refreshing actually works —
 * a mocked refresh proves the code path and nothing about the grant. It is
 * flagged separately so no report can blur the two.
 *
 * Nothing here prints a token, a secret, or any part of one. Values are
 * described by length and shape.
 */
import { db } from "../src/lib/db";
import { env } from "../src/lib/env";
import { decryptSecret } from "../src/lib/crypto";
import { withTenantContext } from "../src/lib/tenant-db";
import { accessTokenFor, disconnectConnection } from "../src/lib/integrations/connections";
import { PROVIDERS } from "../src/lib/integrations/providers";
import { BACKFILL_WINDOW_DAYS, MAX_BACKFILL_PAGES } from "../src/lib/integrations/sync/graph";

if (!env.databaseUrl.startsWith("file:")) {
  console.error("\nThis verifies the LOCAL canary. Refusing to run against a non-SQLite database.\n");
  process.exit(1);
}

function ok(label: string, detail = ""): void {
  console.log(`    PASS  ${label}${detail ? `  — ${detail}` : ""}`);
}
function bad(label: string, detail = ""): void {
  console.log(`    FAIL  ${label}${detail ? `  — ${detail}` : ""}`);
  process.exitCode = 1;
}
/** One assertion, so a failure is never a silently discarded expression. */
function check(passed: boolean, label: string, detail = ""): void {
  if (passed) ok(label, detail);
  else bad(label, detail);
}

async function connection() {
  const row = await db.integration.findFirst({
    where: { provider: "outlook", status: { not: "mock" } },
    select: {
      id: true, workspaceId: true, userId: true, status: true, accountEmail: true,
      credentials: true, tokenExpiresAt: true, syncGeneration: true, scopes: true,
    },
  });
  if (!row) {
    console.error("\nNo real Outlook connection found. Connect one first.\n");
    process.exit(1);
  }
  return row;
}

async function encryption() {
  const row = await connection();
  console.log("\n1. Encrypted credential storage");
  console.log("=".repeat(70));

  const sealed = row.credentials ?? "";
  if (!sealed) return bad("a credential is stored");
  ok("a credential is stored", `${sealed.length} characters`);

  check(
    sealed.startsWith("v1.integration-credentials."),
    "it is this codebase's envelope",
    sealed.startsWith("v1.integration-credentials.")
      ? "v1.integration-credentials.<iv>.<tag>.<ciphertext>"
      : `starts ${JSON.stringify(sealed.slice(0, 12))}`,
  );

  // The decisive test: decrypt it, then prove the plaintext is absent from the
  // column. Comparing against what is actually inside beats looking for a
  // guessed prefix.
  let parsed: { accessToken?: string; refreshToken?: string; scope?: string };
  try {
    parsed = JSON.parse(decryptSecret(sealed, "integration-credentials"));
    ok("it decrypts with the integration-credentials key");
  } catch (error) {
    return bad("it decrypts", String((error as Error).name));
  }

  const access = parsed.accessToken ?? "";
  const refresh = parsed.refreshToken ?? "";
  check(access.length > 100, "it contains an access token", `${access.length} characters`);
  check(refresh.length > 100, "it contains a refresh token", `${refresh.length} characters`);

  // Neither token may appear in the stored column in clear, nor any long run
  // of one — a partial leak is still a leak.
  for (const [name, token] of [["access", access], ["refresh", refresh]] as const) {
    const chunk = token.slice(0, 40);
    check(
      !sealed.includes(token) && !sealed.includes(chunk),
      `the ${name} token is not readable in the column`,
    );
  }

  // Wrong purpose must not decrypt, which is what keeps this key separate from
  // the one protecting MFA secrets.
  try {
    decryptSecret(sealed, "integration-credentials".replace("integration", "other") as never);
    bad("a wrong purpose is refused");
  } catch {
    ok("a wrong purpose is refused");
  }

  check(
    Boolean(row.tokenExpiresAt),
    "an expiry is recorded in clear, for refresh scheduling",
    row.tokenExpiresAt?.toISOString() ?? "none",
  );

  // offline_access is not echoed by Microsoft, so its absence from `scopes` is
  // expected — the refresh token above is the evidence that it was granted.
  console.log(`\n    scopes as returned: ${row.scopes}`);
  console.log("    (offline_access is not echoed by Microsoft; the refresh token is the proof)");
}

async function refresh() {
  const row = await connection();
  console.log("\n2. Token refresh  — THIS CONTACTS MICROSOFT");
  console.log("=".repeat(70));

  const before = JSON.parse(decryptSecret(row.credentials!, "integration-credentials")) as {
    accessToken: string;
    refreshToken: string;
  };

  // Force the refresh path by moving the recorded expiry inside the margin.
  // The grant is untouched; only our note of when it expires changes.
  await db.integration.update({
    where: { id: row.id },
    data: { tokenExpiresAt: new Date(Date.now() + 60_000) },
  });
  ok("expiry moved inside the refresh margin", "so the next read must refresh");

  let token: string;
  try {
    token = await withTenantContext(
      { workspaceIds: [row.workspaceId], userId: row.userId, restrictedWorkspaceIds: [] },
      () => accessTokenFor(row.id, PROVIDERS.outlook),
    );
  } catch (error) {
    return bad("the refresh succeeded", `${(error as Error).message}`);
  }
  ok("the refresh succeeded", `a new access token of ${token.length} characters`);

  const after = await db.integration.findUniqueOrThrow({
    where: { id: row.id },
    select: { credentials: true, tokenExpiresAt: true, status: true, lastError: true },
  });
  const stored = JSON.parse(decryptSecret(after.credentials!, "integration-credentials")) as {
    accessToken: string;
    refreshToken: string;
  };

  check(stored.accessToken === token, "the new token was persisted");
  check(
    stored.accessToken !== before.accessToken,
    "it is a different token from the one stored before",
  );
  check(
    after.credentials!.startsWith("v1.integration-credentials."),
    "it was re-encrypted, not written in clear",
  );
  check(!after.credentials!.includes(token), "the new token is not readable in the column");
  check(
    stored.refreshToken.length > 100,
    "a refresh token is still stored",
    stored.refreshToken === before.refreshToken
      ? "unrotated, and the previous one kept"
      : "rotated, and the new one kept",
  );
  check(
    (after.tokenExpiresAt?.getTime() ?? 0) > Date.now() + 10 * 60_000,
    "the expiry moved forward",
    after.tokenExpiresAt?.toISOString() ?? "none",
  );
  check(
    after.status === "connected" && !after.lastError,
    "the connection is still healthy",
    `${after.status} ${after.lastError ?? ""}`,
  );
}

async function disconnect() {
  const row = await connection();
  console.log("\n3. Disconnect");
  console.log("=".repeat(70));

  // Something to prove retention with.
  const marker = `canary-retention-${Date.now()}`;
  await db.emailMessage.create({
    data: {
      workspaceId: row.workspaceId, provider: "outlook", externalId: marker,
      threadId: marker, subject: "Filed against a deal", snippet: "…",
      fromEmail: "client@example.test", sentAt: new Date(),
      integrationId: row.id, source: "imported", ownerUserId: row.userId, visibility: "private",
    },
  });
  ok("a stand-in imported message exists", "to prove what happens to retained data");

  const result = await withTenantContext(
    { workspaceIds: [row.workspaceId], userId: row.userId, restrictedWorkspaceIds: [] },
    () => disconnectConnection({ integrationId: row.id, userId: row.userId, keepImported: true }),
  );

  const after = await db.integration.findUniqueOrThrow({
    where: { id: row.id },
    select: { status: true, credentials: true, tokenExpiresAt: true, syncGeneration: true, syncCursor: true },
  });
  check(after.credentials === null, "the credential was destroyed");
  check(after.tokenExpiresAt === null, "the expiry was cleared");
  check(after.status === "disconnected", "the status is disconnected", after.status);
  check(
    after.syncGeneration === row.syncGeneration + 1,
    "the sync generation advanced",
    `${row.syncGeneration} → ${after.syncGeneration}`,
  );
  check(after.syncCursor === null, "the sync cursor was cleared");

  const kept = await db.emailMessage.findUnique({
    where: { id: (await db.emailMessage.findFirstOrThrow({ where: { externalId: marker }, select: { id: true } })).id },
    select: { integrationId: true, source: true, visibility: true, ownerUserId: true },
  }).catch(() => null);
  if (!kept) {
    bad("imported data was kept", "the message is gone despite keepImported");
  } else {
    ok("imported data was kept", "keepImported: true");
    // Deliberately kept, not released. `onDelete: SetNull` fires when the
    // Integration row is *deleted*; a disconnect keeps the row so the customer
    // can still see which connection a message came from, and so a later
    // "remove this connection's data" has something to target. Verified against
    // the real connection, which is how the earlier claim was found to be wrong.
    check(
      kept.integrationId === row.id,
      "its connection link is kept, so its origin is still known",
      kept.integrationId === null ? "released, which loses which mailbox it came from" : "",
    );
    check(kept.source === "imported", "its provenance survived, so it stays out of AI");
    check(
      kept.visibility === "private" && kept.ownerUserId === row.userId,
      "it is still private to its owner",
    );
  }
  console.log(`\n    removed on request: ${result.removedEmails} messages, ${result.removedEvents} events`);
  await db.emailMessage.deleteMany({ where: { externalId: marker } });
  console.log("    (the stand-in message has been cleaned up)");
  console.log("\n  The connection is now disconnected. Reconnect from Settings when you want it back.\n");
}

/**
 * Reports what a real sync actually did — counts, dates and privacy only.
 *
 * **Nothing here prints a subject, a snippet, an address, a thread id or a
 * token.** Verifying an import must not become a way of reading the mailbox,
 * and a verification report is exactly the kind of output that gets pasted
 * into a chat window or a ticket. Lengths, counts and dates carry everything
 * needed to judge whether the import behaved.
 */
async function syncReport() {
  const row = await connection();
  console.log("\n4. What the import did");
  console.log("=".repeat(70));

  const state = await db.integration.findUniqueOrThrow({
    where: { id: row.id },
    select: {
      status: true, syncState: true, lastSyncAt: true, syncCursor: true,
      pagesImported: true, backfillTruncated: true, backfillCompletedAt: true,
      importedThrough: true, syncGeneration: true,
    },
  });

  const messages = await db.emailMessage.findMany({
    where: { integrationId: row.id },
    select: {
      sentAt: true, visibility: true, ownerUserId: true, source: true,
      contactId: true, subject: true, snippet: true,
    },
  });

  console.log(`\n    status           ${state.status} / ${state.syncState}`);
  console.log(`    generation       ${state.syncGeneration}`);
  console.log(`    pages fetched    ${state.pagesImported} of ${MAX_BACKFILL_PAGES}`);
  console.log(`    messages         ${messages.length}`);
  console.log(`    linked           ${messages.filter((m) => m.contactId).length}`);
  console.log(`    unlinked         ${messages.filter((m) => !m.contactId).length}`);

  const dates = messages.map((m) => m.sentAt.getTime()).sort((a, b) => a - b);
  console.log(`    oldest imported  ${dates.length ? new Date(dates[0]!).toISOString().slice(0, 10) : "—"}`);
  console.log(`    newest imported  ${dates.length ? new Date(dates.at(-1)!).toISOString().slice(0, 10) : "—"}`);
  console.log(`    importedThrough  ${state.importedThrough?.toISOString().slice(0, 10) ?? "—"}`);
  console.log(`    last checked     ${state.lastSyncAt?.toISOString() ?? "never"}`);

  console.log("\n  Completeness");
  const windowStart = new Date(Date.now() - BACKFILL_WINDOW_DAYS * 86_400_000);
  check(
    !state.backfillTruncated,
    "the import reached the end of the window",
    state.backfillTruncated
      ? `stopped at the ${MAX_BACKFILL_PAGES}-page cap; resume is offered and the cursor is kept`
      : `${BACKFILL_WINDOW_DAYS}-day window from ${windowStart.toISOString().slice(0, 10)}`,
  );
  if (state.backfillTruncated) {
    check(Boolean(state.syncCursor), "a cursor was kept, so resuming continues rather than restarts");
  }
  check(Boolean(state.backfillCompletedAt), "the backfill finished rather than stalling");

  console.log("\n  Privacy of what was imported");
  check(
    messages.every((m) => m.visibility === "private"),
    "every imported message is private",
    `${messages.filter((m) => m.visibility !== "private").length} were not`,
  );
  check(
    messages.every((m) => m.ownerUserId === row.userId),
    "every imported message is owned by the connecting account",
  );
  check(
    messages.every((m) => m.source === "imported"),
    "every imported message is marked imported, so none is AI-eligible",
  );

  // What a colleague would see. Counted through the application's own
  // visibility rule rather than asserted from the column, because that is the
  // path a page actually takes.
  const { visibleToUser } = await import("../src/lib/integrations/visibility");
  const otherUser = await db.user.findFirst({
    where: { id: { not: row.userId } },
    select: { id: true },
  });
  if (otherUser) {
    const visibleToThem = await db.emailMessage.count({
      where: { integrationId: row.id, ...visibleToUser(otherUser.id) },
    });
    check(visibleToThem === 0, "another account can see none of them", `${visibleToThem} visible`);
  } else {
    console.log("    (no second account in this database to check visibility against)");
  }

  const activities = await db.activity.count({
    where: { contactId: { in: messages.map((m) => m.contactId).filter(Boolean) as string[] } },
  });
  check(activities === 0, "no workspace-visible activity row was created for them");

  console.log("\n  AI exclusion");
  const aiEligible = await db.emailMessage.count({
    where: { integrationId: row.id, source: "seed" },
  });
  check(aiEligible === 0, "none of them is classified as seed data");

  // Proof that no content is being printed: the report never touched these.
  const withContent = messages.filter((m) => m.subject || m.snippet).length;
  console.log(
    `\n    (${withContent} messages carry a subject or snippet; none has been printed here)\n`,
  );
}

const which = process.argv.find((a) => a.startsWith("--"));
const run =
  which === "--encryption" ? encryption :
  which === "--refresh" ? refresh :
  which === "--disconnect" ? disconnect :
  which === "--sync" ? syncReport :
  null;

if (!run) {
  console.error("\nUsage: --encryption | --refresh | --disconnect | --sync\n");
  process.exit(1);
}
run()
  .then(() => db.$disconnect())
  .catch(async (error) => {
    console.error(`\n${String(error?.message ?? error)}\n`);
    await db.$disconnect();
    process.exit(1);
  });
