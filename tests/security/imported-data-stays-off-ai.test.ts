import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { db, createTenant, cleanupTenants, type Tenant } from "../helpers/fixtures";
import { buildWorkspaceSnapshot } from "../../src/lib/ai/context";

/**
 * Imported mail and meetings never reach a model provider.
 *
 * Connecting a mailbox is consent to see correspondence inside the CRM. It is
 * not consent to send it to Anthropic, and Phase 1 does not ask for the second
 * one — so the exclusion has to be real rather than intended.
 *
 * ## What this is a regression test for
 *
 * Two reads already sent mail content to a provider before any connector
 * existed: `buildWorkspaceSnapshot` pulled subject *and snippet* for every
 * thread flagged `needsReply`, and `recommendations` pulled subjects. Both
 * predate a real connection, so only seeded demonstration rows ever flowed —
 * which is exactly what made it invisible. The day a sync wrote its first row,
 * that would have become a live disclosure with no code change and no review.
 *
 * The assertion is on the **rendered snapshot text**, not on a `where` clause.
 * A test that checked the query would pass if someone added a third read, and a
 * third read is precisely how this happens.
 */

let tenant: Tenant;
const SECRET_SUBJECT = "ACQUISITION TERMS DO NOT SEND";
const SECRET_SNIPPET = "the number we discussed was forty-one million";
const SEEDED_SUBJECT = "Seeded thread that may be summarised";

before(async () => {
  tenant = await createTenant("AiExclusion", { plan: "pro" });

  const contact = await db.contact.create({
    data: {
      workspaceId: tenant.workspaceId,
      firstName: "Imported",
      lastName: "Contact",
      fullName: "Imported Contact",
      email: "imported@example.test",
    },
    select: { id: true },
  });

  await db.emailMessage.createMany({
    data: [
      {
        workspaceId: tenant.workspaceId,
        provider: "outlook",
        externalId: "ai-imported-1",
        threadId: "t-imported",
        subject: SECRET_SUBJECT,
        snippet: SECRET_SNIPPET,
        fromEmail: "banker@example.test",
        sentAt: new Date(Date.now() - 86_400_000),
        needsReply: true,
        contactId: contact.id,
        source: "imported",
        ownerUserId: tenant.ownerId,
        visibility: "private",
      },
      {
        workspaceId: tenant.workspaceId,
        provider: "mock",
        externalId: "ai-seeded-1",
        threadId: "t-seeded",
        subject: SEEDED_SUBJECT,
        snippet: "nothing confidential here",
        fromEmail: "demo@example.test",
        sentAt: new Date(Date.now() - 86_400_000),
        needsReply: true,
        contactId: contact.id,
        source: "seed",
        visibility: "workspace",
      },
    ],
  });

  await db.calendarEvent.createMany({
    data: [
      {
        workspaceId: tenant.workspaceId,
        provider: "google_calendar",
        externalId: "ai-imported-ev",
        title: "BOARD MEETING DO NOT SEND",
        startAt: new Date(Date.now() + 3_600_000),
        endAt: new Date(Date.now() + 7_200_000),
        source: "imported",
        ownerUserId: tenant.ownerId,
        visibility: "private",
      },
      {
        workspaceId: tenant.workspaceId,
        provider: "mock",
        externalId: "ai-seeded-ev",
        title: "Seeded standup",
        startAt: new Date(Date.now() + 3_600_000),
        endAt: new Date(Date.now() + 7_200_000),
        source: "seed",
        visibility: "workspace",
      },
    ],
  });
});

after(async () => {
  await db.emailMessage.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await db.calendarEvent.deleteMany({ where: { workspaceId: tenant.workspaceId } });
  await cleanupTenants([tenant]);
  await db.$disconnect();
});

const scope = () => ({
  workspaceIds: [tenant.workspaceId],
  userId: tenant.ownerId,
  restrictedWorkspaceIds: [],
  workspaceNames: new Map([[tenant.workspaceId, "AiExclusion"]]),
});

describe("the AI snapshot cannot carry imported mail or meetings", () => {
  test("an imported thread's subject and snippet are absent from the snapshot", async () => {
    const snapshot = await buildWorkspaceSnapshot(scope());
    const text = JSON.stringify(snapshot);

    assert.ok(
      !text.includes(SECRET_SUBJECT),
      "an imported email subject reached the AI snapshot, which is sent to a model provider",
    );
    assert.ok(
      !text.includes(SECRET_SNIPPET),
      "an imported email snippet reached the AI snapshot",
    );
    assert.ok(
      !text.includes("BOARD MEETING DO NOT SEND"),
      "an imported calendar event title reached the AI snapshot",
    );
  });

  test("seeded demonstration data is still included, so nothing regresses", async () => {
    // The exclusion must be narrow. If it swept up seeded rows the daily brief
    // would look broken in every demo workspace while protecting nobody.
    const snapshot = await buildWorkspaceSnapshot(scope());
    const text = JSON.stringify(snapshot);
    assert.ok(
      text.includes(SEEDED_SUBJECT) || text.includes("Seeded standup"),
      "the exclusion also removed seeded demonstration data",
    );
  });

  test("no citation points at an imported record either", async () => {
    // A citation carries an id and a label. The label is the subject.
    const snapshot = await buildWorkspaceSnapshot(scope());
    const imported = await db.emailMessage.findMany({
      where: { workspaceId: tenant.workspaceId, source: "imported" },
      select: { id: true },
    });
    const importedIds = new Set(imported.map((r) => r.id));
    for (const citation of snapshot.citations ?? []) {
      assert.ok(
        !importedIds.has(citation.id),
        `a citation referenced imported record ${citation.id}`,
      );
    }
  });
});
