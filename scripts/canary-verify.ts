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

const which = process.argv.find((a) => a.startsWith("--"));
const run =
  which === "--encryption" ? encryption :
  which === "--refresh" ? refresh :
  which === "--disconnect" ? disconnect :
  null;

if (!run) {
  console.error("\nUsage: --encryption | --refresh | --disconnect\n");
  process.exit(1);
}
run()
  .then(() => db.$disconnect())
  .catch(async (error) => {
    console.error(`\n${String(error?.message ?? error)}\n`);
    await db.$disconnect();
    process.exit(1);
  });
