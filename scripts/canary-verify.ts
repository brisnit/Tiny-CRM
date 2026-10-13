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

async function connection(provider: "outlook" | "outlook_calendar" = "outlook") {
  const row = await db.integration.findFirst({
    where: { provider, status: { not: "mock" } },
    select: {
      id: true, workspaceId: true, userId: true, status: true, accountEmail: true,
      credentials: true, tokenExpiresAt: true, syncGeneration: true, scopes: true,
    },
  });
  if (!row) {
    console.error(
      `\nNo real ${provider} connection found. Connect one first.\n` +
        (provider === "outlook_calendar"
          ? "Outlook Calendar is a SEPARATE grant from Outlook email: it needs its own\n" +
            "Calendars.Read consent, so connecting the mailbox did not connect it.\n" +
            "Settings -> Integrations -> Outlook Calendar -> Connect.\n"
          : ""),
    );
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

  // What the queue thinks, which is the only place that distinguishes an
  // import that has not begun from one that finished with nothing to show.
  const jobs = await db.domainEvent.findMany({
    where: { name: "integration.sync", entityId: row.id },
    select: { status: true, attempts: true, availableAt: true, lastError: true, payload: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  // `DomainEvent.payload` is a String column, not Json — it has to be parsed.
  // Reading it as an object silently matched nothing, which made a queued job
  // look like no job at all: the "not started" and "pending" states this
  // function exists to tell apart.
  const thisGeneration = jobs.filter((j) => {
    try {
      return (JSON.parse(j.payload) as { generation?: number }).generation === state.syncGeneration;
    } catch {
      return false;
    }
  });
  const waiting = thisGeneration.filter((j) => j.status === "pending" || j.status === "failed");
  const dead = thisGeneration.filter((j) => j.status === "dead");

  console.log("\n  Completeness");
  const windowStart = new Date(Date.now() - BACKFILL_WINDOW_DAYS * 86_400_000);

  /**
   * Five outcomes, not two.
   *
   * The earlier version asked one question — `!backfillTruncated` — and
   * reported "the import reached the end of the window". That is also true of
   * an import that never ran: nothing had been truncated because nothing had
   * been fetched. The canary duly PASSed a completeness check on zero
   * messages, zero pages and `lastSyncAt` of never, which is exactly the kind
   * of green that hides a defect. Each state below is now named, and only two
   * of the five are a pass.
   */
  const outcome =
    state.backfillCompletedAt && messages.length > 0
      ? "completed_with_records"
      : state.backfillCompletedAt
        ? "completed_empty"
        : dead.length > 0
          ? "failed"
          : waiting.length > 0
            ? "pending"
            : "not_started";

  const DESCRIPTION: Record<string, string> = {
    not_started: "NOT STARTED — nothing is queued and nothing has run",
    pending: "PENDING — queued, not yet run; a worker or the cron has to pick it up",
    failed: "FAILED — the job dead-lettered after exhausting its attempts",
    completed_empty: "COMPLETED, EMPTY — the import ran and the window genuinely held nothing",
    completed_with_records: "COMPLETED — the import ran and brought records back",
  };
  console.log(`\n    import state     ${DESCRIPTION[outcome]}`);
  console.log(
    `    queue            ${thisGeneration.length} job(s) for generation ${state.syncGeneration}` +
      ` — ${waiting.length} waiting, ${dead.length} dead`,
  );
  if (dead.length > 0 && dead[0]!.lastError) {
    console.log(`    last error       ${dead[0]!.lastError.slice(0, 200)}`);
  }

  switch (outcome) {
    case "not_started":
      bad(
        "the import has started",
        "no sync job exists for this generation — connecting did not queue one, or it was lost",
      );
      break;
    case "pending":
      bad(
        "the import has run",
        `queued ${waiting.length === 1 ? "job is" : "jobs are"} still waiting; ` +
          `run it with: npm run worker -- --once`,
      );
      break;
    case "failed":
      bad("the import ran without dead-lettering", `${dead.length} job(s) gave up`);
      break;
    case "completed_empty":
      ok(
        "the import completed",
        `the ${BACKFILL_WINDOW_DAYS}-day window from ${windowStart.toISOString().slice(0, 10)} ` +
          `held no messages — this is an empty result, not an unstarted one`,
      );
      break;
    case "completed_with_records":
      ok("the import completed", `${messages.length} message(s) brought back`);
      break;
  }

  // Truncation is only meaningful once something ran; asking it of an
  // unstarted import is what produced the false pass in the first place.
  if (state.backfillCompletedAt) {
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
  } else {
    console.log("    ----  completeness of the window is not assessable until the import runs");
  }

  console.log("\n  Privacy of what was imported");
  if (messages.length === 0) {
    // `[].every(…)` is true, so each of these would have PASSed on nothing —
    // the same vacuous green as the completeness check above. A privacy claim
    // over an empty set is not a privacy guarantee, and saying so is the
    // honest report.
    console.log("    ----  no imported messages, so there is nothing to make a privacy claim about");
  } else {
    check(
      messages.every((m) => m.visibility === "private"),
      `all ${messages.length} imported messages are private`,
      `${messages.filter((m) => m.visibility !== "private").length} were not`,
    );
    check(
      messages.every((m) => m.ownerUserId === row.userId),
      `all ${messages.length} are owned by the connecting account`,
    );
    check(
      messages.every((m) => m.source === "imported"),
      `all ${messages.length} are marked imported, so none is AI-eligible`,
    );
  }

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


/**
 * Runs one real incremental pass end to end and checks what it did.
 *
 * Everything in one process deliberately: the invariants that matter are
 * before/after comparisons, and a report that only sees the "after" cannot
 * tell a pass that imported nothing from one that never ran — the exact
 * confusion that let "0 pages, 0 messages, last checked never" read as a PASS
 * for weeks.
 *
 * It forces the schedule (`idleMs: 0`) rather than waiting out the half-hour
 * interval, which is the only difference from what the cron does in
 * production.
 */
async function incrementalReport() {
  const row = await connection();
  console.log("\n5. One incremental pass, start to finish");
  console.log("=".repeat(70));

  const before = await db.integration.findUniqueOrThrow({
    where: { id: row.id },
    select: {
      syncState: true, lastSyncAt: true, pagesImported: true,
      backfillCompletedAt: true, backfillTruncated: true, syncGeneration: true,
    },
  });
  const messagesBefore = await db.emailMessage.count({ where: { integrationId: row.id } });
  const newestBefore = await db.emailMessage.findFirst({
    where: { integrationId: row.id },
    orderBy: { sentAt: "desc" },
    select: { sentAt: true },
  });

  console.log(`\n    before           ${before.syncState}, ${messagesBefore} messages, ` +
    `${before.pagesImported} pages, last checked ${before.lastSyncAt?.toISOString() ?? "never"}`);

  if (!before.backfillCompletedAt) {
    bad("the backfill has completed", "an incremental pass is not scheduled until it has");
    return;
  }

  const { scheduleDueSyncs } = await import("../src/lib/integrations/sync/schedule");
  const scheduled = await scheduleDueSyncs({ idleMs: 0 });
  console.log(`    scheduled        considered ${scheduled.considered}, queued ${scheduled.queued}, skipped ${scheduled.skipped}`);
  check(scheduled.queued === 1, "the scheduler queued exactly one incremental pass");
  if (scheduled.queued !== 1) return;

  // Drain, exactly as `npm run worker -- --once` would.
  const { registerJobHandlers } = await import("../src/lib/jobs/handlers");
  const { runJobs } = await import("../src/lib/jobs");
  registerJobHandlers();
  let handled = 0;
  for (let i = 0; i < 20; i += 1) {
    const result = await runJobs(10);
    handled += result.processed + result.failed + result.dead;
    if (result.processed + result.failed + result.dead === 0) break;
    if (result.failed || result.dead) {
      bad("the pass ran without failing", `${result.failed} failed, ${result.dead} dead`);
      break;
    }
  }
  console.log(`    jobs handled     ${handled}`);

  const after = await db.integration.findUniqueOrThrow({
    where: { id: row.id },
    select: {
      syncState: true, lastSyncAt: true, pagesImported: true,
      backfillCompletedAt: true, backfillTruncated: true, syncGeneration: true,
    },
  });
  const messagesAfter = await db.emailMessage.count({ where: { integrationId: row.id } });
  const newestAfter = await db.emailMessage.findFirst({
    where: { integrationId: row.id },
    orderBy: { sentAt: "desc" },
    select: { sentAt: true },
  });

  console.log(`    after            ${after.syncState}, ${messagesAfter} messages, ` +
    `${after.pagesImported} pages, last checked ${after.lastSyncAt?.toISOString() ?? "never"}`);
  console.log(`    new this pass    ${messagesAfter - messagesBefore}`);
  console.log(`    newest message   ${newestBefore?.sentAt.toISOString().slice(0, 10) ?? "—"}` +
    ` -> ${newestAfter?.sentAt.toISOString().slice(0, 10) ?? "—"}`);

  console.log("\n  What an incremental pass must not do");
  check(
    after.backfillCompletedAt?.getTime() === before.backfillCompletedAt?.getTime(),
    "the completed backfill was left alone",
    "reopening it stops this connection being scheduled ever again",
  );
  check(
    after.pagesImported === before.pagesImported,
    "the backfill's page budget was not spent",
    `${after.pagesImported - before.pagesImported} page(s) were charged to it`,
  );
  check(after.backfillTruncated === false, "the truncation flag was not raised");
  check(after.syncGeneration === before.syncGeneration, "the generation did not move");
  check(
    after.syncState === "idle",
    "the pass finished and left the connection idle",
    `it is ${after.syncState}, so a chain is still open and the next pass will be skipped`,
  );
  check(
    Boolean(after.lastSyncAt && before.lastSyncAt && after.lastSyncAt > before.lastSyncAt),
    "the clock moved forward, so the next pass reads from a newer point",
  );
  check(
    messagesAfter >= messagesBefore,
    "nothing was lost",
    `${messagesBefore - messagesAfter} message(s) disappeared`,
  );

  console.log("\n  Privacy of anything new");
  const leaked = await db.emailMessage.count({
    where: {
      integrationId: row.id,
      OR: [{ visibility: { not: "private" } }, { ownerUserId: { not: row.userId } }, { source: { not: "imported" } }],
    },
  });
  check(leaked === 0, "every message is still private, owned and marked imported", `${leaked} were not`);
  console.log("\n    (no subject, snippet, address or token has been printed)\n");
}

/** The calendar connection, reported like the mailbox but counting meetings. */
async function calendarReport() {
  const row = await connection("outlook_calendar");
  console.log("\n6. The Outlook Calendar canary");
  console.log("=".repeat(70));

  const state = await db.integration.findUniqueOrThrow({
    where: { id: row.id },
    select: {
      status: true, syncState: true, lastSyncAt: true, pagesImported: true,
      backfillCompletedAt: true, backfillTruncated: true, syncGeneration: true,
    },
  });
  const events = await db.calendarEvent.findMany({
    where: { integrationId: row.id },
    select: {
      startAt: true, endAt: true, visibility: true, ownerUserId: true,
      source: true, contactId: true, allDay: true,
    },
  });

  console.log(`\n    status           ${state.status} / ${state.syncState}`);
  console.log(`    generation       ${state.syncGeneration}`);
  console.log(`    pages fetched    ${state.pagesImported} of ${MAX_BACKFILL_PAGES}`);
  console.log(`    meetings         ${events.length}`);
  console.log(`    linked           ${events.filter((e) => e.contactId).length}`);
  console.log(`    all-day          ${events.filter((e) => e.allDay).length}`);
  console.log(`    last checked     ${state.lastSyncAt?.toISOString() ?? "never"}`);

  const times = events.map((e) => e.startAt.getTime()).sort((a, b) => a - b);
  console.log(`    earliest         ${times.length ? new Date(times[0]!).toISOString().slice(0, 10) : "—"}`);
  console.log(`    latest           ${times.length ? new Date(times.at(-1)!).toISOString().slice(0, 10) : "—"}`);

  console.log("\n  Completeness");
  if (!state.backfillCompletedAt) {
    bad("the import has run", "nothing has been fetched yet — run: npm run worker -- --once");
  } else if (events.length === 0) {
    ok("the import completed", "the window genuinely held no meetings — empty, not unstarted");
  } else {
    ok("the import completed", `${events.length} meeting(s) brought back`);
    // The window is ±: a calendar that only reached backwards would be the
    // forward bound silently failing.
    const now = Date.now();
    const future = events.filter((e) => e.startAt.getTime() > now).length;
    console.log(`    ${events.filter((e) => e.startAt.getTime() <= now).length} past, ${future} upcoming`);
  }
  check(!state.backfillTruncated, "the import was not stopped by the page cap");

  console.log("\n  Privacy");
  if (events.length === 0) {
    console.log("    ----  no meetings, so there is nothing to make a privacy claim about");
  } else {
    check(events.every((e) => e.visibility === "private"), `all ${events.length} meetings are private`);
    check(events.every((e) => e.ownerUserId === row.userId), `all ${events.length} are owned by the connecting account`);
    check(events.every((e) => e.source === "imported"), `all ${events.length} are marked imported`);

    const { visibleToUser } = await import("../src/lib/integrations/visibility");
    const other = await db.user.findFirst({ where: { id: { not: row.userId } }, select: { id: true } });
    if (other) {
      const visible = await db.calendarEvent.count({
        where: { integrationId: row.id, ...visibleToUser(other.id) },
      });
      check(visible === 0, "another account can see none of them", `${visible} visible`);
    }
  }

  // Times are the thing most likely to be silently wrong, and the one thing
  // worth showing: a duration is not content.
  if (events.length > 0) {
    const durations = events
      .filter((e) => !e.allDay)
      .map((e) => Math.round((e.endAt.getTime() - e.startAt.getTime()) / 60_000));
    const odd = durations.filter((m) => m <= 0 || m > 24 * 60).length;
    check(
      odd === 0,
      "every meeting has a sane duration, so the times were read as instants",
      `${odd} have a duration of zero, negative, or over a day — the hallmark of a timezone misread`,
    );
  }
  console.log("\n    (no meeting title, attendee or token has been printed)\n");
}

const which = process.argv.find((a) => a.startsWith("--"));
const run =
  which === "--encryption" ? encryption :
  which === "--refresh" ? refresh :
  which === "--disconnect" ? disconnect :
  which === "--sync" ? syncReport :
  which === "--incremental" ? incrementalReport :
  which === "--calendar" ? calendarReport :
  null;

if (!run) {
  console.error(
    "\nUsage: --encryption | --refresh | --disconnect | --sync | --incremental | --calendar\n",
  );
  process.exit(1);
}
run()
  .then(() => db.$disconnect())
  .catch(async (error) => {
    console.error(`\n${String(error?.message ?? error)}\n`);
    await db.$disconnect();
    process.exit(1);
  });
