import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import { db as observer, createTenant, type Tenant } from "../helpers/fixtures";
import { db } from "../../src/lib/db";
import { withTenantContext } from "../../src/lib/tenant-db";
import { isPostgres } from "../../src/lib/env";

/**
 * AI output belongs to the person who asked for it.
 *
 * Two members of one workspace. Everything Tiny AI writes on someone's behalf —
 * the daily brief, the conversation thread, the messages in it — is derived
 * from a workspace-wide sweep of the most valuable and most urgent records
 * there are. Sharing that by workspace means sharing the sweep, and a brief is
 * a better summary of a company's position than most documents in it.
 *
 * This file is written from the attacker's side. B knows A's row ids exactly —
 * that is the point, because guessing ids is not the threat and never was. The
 * threat is a colleague, already inside the workspace, reading what was
 * assembled for someone else.
 *
 * ACTOR    `db` — the application's client, connected as `tinycrm_app`, bound
 *          by RLS. Every attempt under test runs here.
 * OBSERVER `observer` — privileged, used only to build the world and to read
 *          ground truth. It never performs the operation under test: a
 *          privileged read would prove nothing about an unprivileged one.
 */

const skip = isPostgres ? undefined : { skip: "PostgreSQL with RLS only" };

let A: Tenant;

/** The brief, thread and messages that belong to the workspace owner. */
let ownerBriefId = "";
let ownerThreadId = "";
let ownerMessageId = "";

before(async () => {
  A = await createTenant("AiOwn");

  // Written the way the application writes them: as the owner, in the owner's
  // own tenant context, through the restricted client.
  await withTenantContext({ workspaceIds: [A.workspaceId], userId: A.ownerId }, async () => {
    const brief = await db.aiInsight.create({
      data: {
        workspaceId: A.workspaceId,
        kind: "brief",
        entityType: "user",
        entityId: `${A.ownerId}:${A.workspaceId}`,
        title: "Daily brief",
        body: "Riverside Authority is the largest open pursuit at $480,000.",
        model: "test:model",
        fingerprint: "test-fingerprint",
      },
      select: { id: true },
    });
    ownerBriefId = brief.id;

    const thread = await db.aiThread.create({
      data: { workspaceId: A.workspaceId, userId: A.ownerId, title: "Which deals are at risk?" },
      select: { id: true },
    });
    ownerThreadId = thread.id;

    const message = await db.aiMessage.create({
      data: {
        threadId: thread.id,
        userId: A.ownerId,
        role: "assistant",
        content: "Riverside Authority has slipped twice and is worth $480,000.",
      },
      select: { id: true },
    });
    ownerMessageId = message.id;
  });
});

/** Runs a read as the other member of the same workspace. */
function asOtherMember<T>(fn: () => Promise<T>): Promise<T> {
  return withTenantContext({ workspaceIds: [A.workspaceId], userId: A.memberId }, fn);
}

/** Runs a read as the person the output belongs to. */
function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  return withTenantContext({ workspaceIds: [A.workspaceId], userId: A.ownerId }, fn);
}

describe("a colleague cannot read AI output generated for someone else", () => {
  test("the daily brief, by its exact id", skip ?? {}, async () => {
    const stolen = await asOtherMember(() =>
      db.aiInsight.findFirst({ where: { id: ownerBriefId }, select: { body: true } }),
    );
    assert.equal(stolen, null, "another member read the owner's daily brief");
  });

  test("the daily brief, by sweeping the workspace for briefs", skip ?? {}, async () => {
    // The id is not the only way in. A member who knows briefs exist can ask
    // for all of them.
    const swept = await asOtherMember(() =>
      db.aiInsight.findMany({ where: { kind: "brief" }, select: { id: true } }),
    );
    assert.deepEqual(
      swept.map((row) => row.id),
      [],
      "another member listed briefs that were not theirs",
    );
  });

  test("the conversation thread, by its exact id", skip ?? {}, async () => {
    const stolen = await asOtherMember(() =>
      db.aiThread.findFirst({ where: { id: ownerThreadId }, select: { title: true } }),
    );
    assert.equal(stolen, null, "another member read the owner's AI thread");
  });

  test("the messages in it, by the thread id", skip ?? {}, async () => {
    // Messages carry no workspace of their own; they are reachable only through
    // their thread, so this is the test that the parent gate actually holds.
    const stolen = await asOtherMember(() =>
      db.aiMessage.findMany({ where: { threadId: ownerThreadId }, select: { content: true } }),
    );
    assert.deepEqual(stolen, [], "another member read the answers written for the owner");
  });

  test("a message by its own id, without naming the thread", skip ?? {}, async () => {
    const stolen = await asOtherMember(() =>
      db.aiMessage.findFirst({ where: { id: ownerMessageId }, select: { content: true } }),
    );
    assert.equal(stolen, null, "another member read an answer by message id");
  });

  test("and cannot dismiss what it cannot see", skip ?? {}, async () => {
    const result = await asOtherMember(() =>
      db.aiInsight.updateMany({ where: { id: ownerBriefId }, data: { status: "dismissed" } }),
    );
    assert.equal(result.count, 0, "another member dismissed the owner's brief");

    const after = await observer.aiInsight.findFirst({
      where: { id: ownerBriefId },
      select: { status: true },
    });
    assert.equal(after?.status, "new", "the owner's brief was modified by someone else");
  });
});

describe("the person it belongs to is not locked out", () => {
  // An attack refused and an application broken look identical from the
  // attacker's side, so every denial above is paired with a success here.
  test("the owner still reads their own brief, thread and messages", skip ?? {}, async () => {
    const [brief, thread, messages] = await asOwner(async () => [
      await db.aiInsight.findFirst({ where: { id: ownerBriefId }, select: { body: true } }),
      await db.aiThread.findFirst({ where: { id: ownerThreadId }, select: { title: true } }),
      await db.aiMessage.findMany({ where: { threadId: ownerThreadId }, select: { content: true } }),
    ]);
    assert.ok(brief?.body, "the owner cannot read their own brief");
    assert.ok(thread?.title, "the owner cannot read their own thread");
    assert.equal(messages.length, 1, "the owner cannot read their own messages");
  });

  test("the owner can still dismiss their own brief", skip ?? {}, async () => {
    const result = await asOwner(() =>
      db.aiInsight.updateMany({ where: { id: ownerBriefId }, data: { status: "dismissed" } }),
    );
    assert.equal(result.count, 1, "the owner cannot dismiss their own brief");
    await observer.aiInsight.update({ where: { id: ownerBriefId }, data: { status: "new" } });
  });
});

describe("record summaries stay shared, deliberately", () => {
  // A summary is derived from one record's own notes and activity, and every
  // member who can open that record is meant to see it. This is the line this
  // change does not cross: person-owned output is gated, record-derived output
  // follows its record (and will follow record visibility with Team-2).
  test("a colleague reads a record summary in their workspace", skip ?? {}, async () => {
    const summary = await asOwner(() =>
      db.aiInsight.create({
        data: {
          workspaceId: A.workspaceId,
          kind: "summary",
          entityType: "opportunity",
          entityId: A.opportunityId,
          title: "Summary",
          body: "Two open questions remain with the buyer.",
          model: "test:model",
          fingerprint: "summary-fingerprint",
        },
        select: { id: true },
      }),
    );

    const read = await asOtherMember(() =>
      db.aiInsight.findFirst({ where: { id: summary.id }, select: { body: true } }),
    );
    assert.ok(read?.body, "a record summary stopped being shared with the workspace");
  });
});

describe("no identity, no access", () => {
  test("a context with no user reads no person-owned AI output", skip ?? {}, async () => {
    const seen = await withTenantContext({ workspaceIds: [A.workspaceId], userId: null }, () =>
      db.aiInsight.findMany({ where: { kind: "brief" }, select: { id: true } }),
    );
    assert.deepEqual(seen, [], "briefs were readable with no identity in context");

    const threads = await withTenantContext({ workspaceIds: [A.workspaceId], userId: null }, () =>
      db.aiThread.findMany({ where: { id: ownerThreadId }, select: { id: true } }),
    );
    assert.deepEqual(threads, [], "threads were readable with no identity in context");
  });
});
