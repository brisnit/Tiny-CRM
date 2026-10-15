// A non-UTC zone, set before anything constructs a Date.
//
// This is load-bearing, not hygiene. Graph returns event times as wall-clock
// strings with no offset, and the bug this file guards against — parsing one
// without appending `Z` — is *invisible* on a UTC host, because local time and
// UTC coincide there. CI runners are UTC. Pinning a zone seven or eight hours
// off UTC is what makes the assertion capable of failing at all.
process.env.TZ = "America/Los_Angeles";

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { db, createTenant, cleanupTenants, type Tenant } from "../helpers/fixtures";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { withTenantContext } from "../../src/lib/tenant-db";
import { encryptSecret } from "../../src/lib/crypto";
import {
  CALENDAR_DAYS_BACK,
  CALENDAR_DAYS_FORWARD,
  graphInstant,
  type Transport,
} from "../../src/lib/integrations/sync/graph";
import { runSyncPage } from "../../src/lib/integrations/sync/worker";
import { visibleToUser } from "../../src/lib/integrations/visibility";

/**
 * Importing Outlook Calendar.
 *
 * Every provider response here is a fake; nothing contacts Graph. A pass says
 * nothing about the live provider — the real calendar is verified by hand
 * against the canary and reported separately.
 */
let tenant: Tenant;
let integrationId = "";

function provider(body: unknown, urls?: string[]): Transport {
  return async (url: string) => {
    urls?.push(url);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/** A Graph event as Graph actually returns one: wall clock, no offset. */
function graphEvent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    iCalUId: `ical-${id}`,
    subject: `Meeting ${id}`,
    bodyPreview: "…",
    isAllDay: false,
    isCancelled: false,
    start: { dateTime: "2026-10-13T14:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-10-13T15:00:00.0000000", timeZone: "UTC" },
    location: { displayName: "Room 1" },
    organizer: { emailAddress: { address: "someone@client.test", name: "Someone" } },
    attendees: [{ emailAddress: { address: "me@canary.test" }, type: "required" }],
    ...overrides,
  };
}

before(async () => {
  tenant = await createTenant("CalendarSync", { plan: "pro" });
  // Syncing is gated on the rollout flag as well as the plan, and the flag
  // defaults to off. Without this the suite would assert the gate refusing
  // rather than the behaviour each test is named for.
  await db.featureFlag.upsert({
    where: { key_workspaceId: { key: "integrations", workspaceId: tenant.workspaceId } },
    update: { enabled: true },
    create: { key: "integrations", workspaceId: tenant.workspaceId, enabled: true },
  });
});

after(async () => {
  await db.domainEvent.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await db.calendarEvent.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await db.integration.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await cleanupTenants([tenant]);
  await db.$disconnect();
});

beforeEach(async () => {
  await db.domainEvent.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await db.calendarEvent.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await db.integration.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  const row = await db.integration.create({
    data: {
      workspaceId: tenant.workspaceId,
      userId: tenant.ownerId,
      provider: "outlook_calendar",
      status: "connected",
      accountEmail: "me@canary.test",
      credentials: encryptSecret(
        JSON.stringify({
          accessToken: "fake-access-token",
          refreshToken: "fake-refresh-token",
          scope: "",
          obtainedAt: new Date().toISOString(),
        }),
        "integration-credentials",
      ),
      tokenExpiresAt: new Date(Date.now() + 86_400_000),
      syncGeneration: 1,
      syncState: "backfilling",
    },
    select: { id: true },
  });
  integrationId = row.id;
});

const asOwner = <T>(fn: () => Promise<T>) =>
  runAsTestIdentity(tenant.ownerId, () =>
    withTenantContext(
      { workspaceIds: [tenant.workspaceId], userId: tenant.ownerId, restrictedWorkspaceIds: [] },
      fn,
    ),
  );

describe("a Graph wall-clock time is an instant, not a local one", () => {
  test("a time with no offset is read as UTC, wherever the host is", () => {
    assert.notEqual(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      "UTC",
      "this file must not run in UTC or its central assertion cannot fail",
    );
    const parsed = graphInstant("2026-10-13T14:00:00.0000000");
    assert.equal(
      parsed?.toISOString(),
      "2026-10-13T14:00:00.000Z",
      "a Graph time was read in the host's zone, putting every meeting out by its offset",
    );
  });

  test("a time that already carries a zone is left exactly as it is", () => {
    assert.equal(graphInstant("2026-10-13T14:00:00Z")?.toISOString(), "2026-10-13T14:00:00.000Z");
    assert.equal(
      graphInstant("2026-10-13T07:00:00-07:00")?.toISOString(),
      "2026-10-13T14:00:00.000Z",
      "an offset Graph supplied was ignored or double-applied",
    );
  });

  test("an unusable time is null rather than Invalid Date or the epoch", () => {
    assert.equal(graphInstant(undefined), null);
    assert.equal(graphInstant(""), null);
    assert.equal(graphInstant("not a date"), null);
  });
});

describe("importing a calendar", () => {
  test("the window is asked for in both directions, with unambiguous bounds", async () => {
    const urls: string[] = [];
    await asOwner(() =>
      runSyncPage({ integrationId, generation: 1, cursor: null }, { transport: provider({ value: [] }, urls) }),
    );
    assert.equal(urls.length, 1);
    const asked = new URL(urls[0]!);
    assert.ok(asked.pathname.endsWith("/me/calendarView"), `asked ${asked.pathname}, not calendarView`);

    const start = asked.searchParams.get("startDateTime")!;
    const end = asked.searchParams.get("endDateTime")!;
    // Unambiguous: Graph reads a bound with no offset as UTC, so sending one
    // with an offset is what makes the window mean the same thing either way.
    assert.ok(/(?:Z|[+-]\d{2}:\d{2})$/.test(start), `startDateTime carried no zone: ${start}`);
    assert.ok(/(?:Z|[+-]\d{2}:\d{2})$/.test(end), `endDateTime carried no zone: ${end}`);

    const days = (v: string) => Math.round((new Date(v).getTime() - Date.now()) / 86_400_000);
    assert.equal(days(start), -CALENDAR_DAYS_BACK, "the calendar window reached back the wrong distance");
    assert.equal(days(end), CALENDAR_DAYS_FORWARD, "the calendar window reached forward the wrong distance");
  });

  test("an imported meeting is private, owned, and marked imported", async () => {
    await asOwner(() =>
      runSyncPage(
        { integrationId, generation: 1, cursor: null },
        { transport: provider({ value: [graphEvent("e1"), graphEvent("e2")] }) },
      ),
    );

    const rows = await db.calendarEvent.findMany({
      where: { integrationId },
      select: {
        externalId: true, startAt: true, endAt: true, visibility: true,
        ownerUserId: true, source: true, provider: true, title: true,
      },
    });
    assert.equal(rows.length, 2);
    assert.ok(
      rows.every(
        (r) =>
          r.visibility === "private" &&
          r.ownerUserId === tenant.ownerId &&
          r.source === "imported" &&
          r.provider === "outlook_calendar",
      ),
      "an imported meeting did not get the provenance that keeps it private",
    );
    // And the instant survived the round trip through the database.
    assert.equal(rows[0]!.startAt.toISOString(), "2026-10-13T14:00:00.000Z");
    assert.equal(rows[0]!.endAt.toISOString(), "2026-10-13T15:00:00.000Z");
  });

  test("another person in the workspace cannot see an imported meeting", async () => {
    await asOwner(() =>
      runSyncPage(
        { integrationId, generation: 1, cursor: null },
        { transport: provider({ value: [graphEvent("private-1")] }) },
      ),
    );
    const other = await db.user.findFirst({
      where: { id: { not: tenant.ownerId } },
      select: { id: true },
    });
    if (!other) return; // nothing to compare against in this database
    const visible = await db.calendarEvent.count({
      where: { integrationId, ...visibleToUser(other.id) },
    });
    assert.equal(visible, 0, "an imported meeting was visible to somebody who did not import it");
  });

  test("a meeting that moved is updated, not duplicated", async () => {
    await asOwner(() =>
      runSyncPage(
        { integrationId, generation: 1, cursor: null },
        { transport: provider({ value: [graphEvent("moves")] }) },
      ),
    );

    const moved = graphEvent("moves", {
      subject: "Meeting moves (rescheduled)",
      start: { dateTime: "2026-10-20T16:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-10-20T17:00:00.0000000", timeZone: "UTC" },
    });
    await db.integration.update({ where: { id: integrationId }, data: { syncState: "backfilling" } });
    await asOwner(() =>
      runSyncPage(
        { integrationId, generation: 1, cursor: null },
        { transport: provider({ value: [moved] }) },
      ),
    );

    const rows = await db.calendarEvent.findMany({
      where: { integrationId },
      select: { title: true, startAt: true, visibility: true, source: true, ownerUserId: true },
    });
    assert.equal(rows.length, 1, "a rescheduled meeting was imported a second time instead of moved");
    assert.equal(rows[0]!.title, "Meeting moves (rescheduled)", "the meeting did not take its new title");
    assert.equal(
      rows[0]!.startAt.toISOString(),
      "2026-10-20T16:00:00.000Z",
      "the meeting kept its old time after being rescheduled",
    );
    assert.equal(rows[0]!.source, "imported");
    assert.equal(rows[0]!.ownerUserId, tenant.ownerId);
  });

  test("re-syncing does not un-share a meeting its owner shared", async () => {
    /**
     * The update path's sharpest edge. Sharing is the owner's decision and is
     * recorded on the row; a re-sync that rewrote `visibility` would quietly
     * revoke it the next time the meeting changed — or, in the other
     * direction, could republish something the owner had made private again.
     * So `visibility` is not in the update object at all, and this is what
     * says so.
     */
    await asOwner(() =>
      runSyncPage(
        { integrationId, generation: 1, cursor: null },
        { transport: provider({ value: [graphEvent("shared")] }) },
      ),
    );
    const row = await db.calendarEvent.findFirstOrThrow({
      where: { integrationId },
      select: { id: true },
    });
    await db.calendarEvent.update({
      where: { id: row.id },
      data: { visibility: "workspace", sharedAt: new Date(), sharedById: tenant.ownerId },
    });

    await db.integration.update({ where: { id: integrationId }, data: { syncState: "backfilling" } });
    await asOwner(() =>
      runSyncPage(
        { integrationId, generation: 1, cursor: null },
        {
          transport: provider({
            value: [graphEvent("shared", { subject: "Meeting shared (renamed)" })],
          }),
        },
      ),
    );

    const after = await db.calendarEvent.findUniqueOrThrow({
      where: { id: row.id },
      select: { visibility: true, sharedAt: true, title: true },
    });
    assert.equal(after.title, "Meeting shared (renamed)", "the re-sync did not apply at all");
    assert.equal(after.visibility, "workspace", "a re-sync revoked a share the owner had made");
    assert.ok(after.sharedAt, "a re-sync erased when the meeting was shared");
  });

  test("an event with no usable time is counted, not imported as a bad row", async () => {
    await asOwner(() =>
      runSyncPage(
        { integrationId, generation: 1, cursor: null },
        {
          transport: provider({
            value: [
              graphEvent("fine"),
              graphEvent("broken", { start: { dateTime: undefined }, end: { dateTime: undefined } }),
            ],
          }),
        },
      ),
    );
    const rows = await db.calendarEvent.findMany({
      where: { integrationId },
      select: { externalId: true },
    });
    assert.deepEqual(
      rows.map((r) => r.externalId),
      ["fine"],
      "an event with no usable time was written anyway, or a good one was dropped with it",
    );
  });

  test("a disconnected calendar connection imports nothing", async () => {
    await db.integration.update({
      where: { id: integrationId },
      data: { status: "disconnected", credentials: null },
    });
    const result = await asOwner(() =>
      runSyncPage(
        { integrationId, generation: 1, cursor: null },
        { transport: provider({ value: [graphEvent("after-disconnect")] }) },
      ),
    );
    assert.equal(result.done, true);
    assert.equal(await db.calendarEvent.count({ where: { integrationId } }), 0);
  });
});
