import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { createTenant, cleanupTenants, db as observer, membershipIdFor, type Tenant } from "../helpers/fixtures";
import { requestUpload, confirmUpload } from "../../src/lib/actions/files";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { resetRateLimit } from "../../src/lib/rate-limit";
import { getStorage } from "../../src/lib/storage";
import { LIMITS } from "../../src/lib/validation/limits";
import { isPostgres } from "../../src/lib/env";

/**
 * Project documents, end to end.
 *
 * The file never passes through the application: the browser PUTs it straight
 * to object storage. That is a deliberate constraint and it creates the problem
 * this suite exists to pin down — **the server cannot see the file it is being
 * asked to record.**
 *
 * So the server validates twice. Once at request time, against bytes the client
 * supplied, which is a convenience and is treated as worthless. Once at confirm
 * time, against bytes read back out of storage, which is the evidence. The
 * tests below spend most of their effort on the gap between those two: a client
 * that tells the truth to get a URL and then uploads something else.
 *
 * ACTOR    `requestUpload` / `confirmUpload`, running as a real user through
 *          the same server actions a browser would call, on a connection bound
 *          by row-level security.
 * OBSERVER `observer` — privileged. Builds the world and reads ground truth. It
 *          never performs the operation under test.
 *
 * Needs PostgreSQL (SQLite has no policies, so record scope cannot be observed)
 * and an S3-compatible endpoint (there is nothing to confirm against without
 * one).
 */

const configured = isPostgres && Boolean(process.env.S3_ENDPOINT);
const requirements = configured
  ? undefined
  : { skip: "needs PostgreSQL with RLS and an S3 endpoint (scripts/minio.mjs start)" };

/** `%PDF-1.7` and filler: a real signature, and more than sixteen bytes. */
const PDF: Uint8Array<ArrayBuffer> = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37,
  0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a, 0x31, 0x20, 0x30,
]);

/** What an attacker actually wants stored: script that runs on our origin. */
const HTML: Uint8Array<ArrayBuffer> = new TextEncoder().encode("<html><script>alert(document.cookie)</script></html>");

/** The preflight bytes a *truthful* client would send for the PDF above. */
const HONEST_PREFLIGHT = Buffer.from(PDF.subarray(0, 16)).toString("base64");

let A: Tenant;
const id = { grantedProject: "", ungrantedProject: "" };

type Ticket = {
  uploadToken: string;
  upload: { method: "PUT"; url: string; headers: Record<string, string>; expiresAt: string };
};

/** Asks for an upload URL as a given user. */
async function request(userId: string, projectId: string, over: Record<string, unknown> = {}) {
  return runAsTestIdentity(userId, () =>
    requestUpload({
      projectId,
      filename: "q3-proposal.pdf",
      declaredMimeType: "application/pdf",
      sizeBytes: PDF.length,
      headBase64: HONEST_PREFLIGHT,
      ...over,
    }),
  );
}

/** Performs the browser's half: a direct PUT to object storage. */
async function upload(ticket: Ticket, body: Uint8Array<ArrayBuffer>): Promise<Response> {
  return fetch(ticket.upload.url, {
    method: ticket.upload.method,
    headers: ticket.upload.headers,
    body,
  });
}

async function confirm(userId: string, uploadToken: string) {
  return runAsTestIdentity(userId, () => confirmUpload({ uploadToken }));
}

/** Ground truth: the rows that actually exist, read privileged. */
async function filesOn(projectId: string) {
  return observer.fileAsset.findMany({ where: { projectId }, select: { id: true, name: true, storageKey: true, sizeBytes: true, mimeType: true, uploaderId: true } });
}

before(async () => {
  if (!configured) {
    console.log("  (project documents suite skipped: needs PostgreSQL + S3_ENDPOINT)");
    return;
  }

  A = await createTenant("Documents");
  id.grantedProject = A.projectId;

  // `files` defaults to off, and the actions enforce it. Enabling it for this
  // one workspace is what a beta rollout would do; the global default is
  // untouched, so nothing here turns the feature on for the product.
  await observer.featureFlag.create({
    data: { key: "files", enabled: true, workspaceId: A.workspaceId },
  });

  const second = await observer.project.create({
    data: {
      workspaceId: A.workspaceId,
      name: "Work they were not given",
      statusId: A.statusId,
      ownerId: A.ownerId,
    },
    select: { id: true },
  });
  id.ungrantedProject = second.id;

  // The member becomes restricted, and is given exactly one of the two
  // projects. Everything below asks what that buys them.
  await observer.workspaceMember.updateMany({
    where: { workspaceId: A.workspaceId, userId: A.memberId },
    data: { scopeMode: "restricted" },
  });
  await observer.recordGrant.create({
    data: {
      workspaceId: A.workspaceId,
      userId: A.memberId,
      membershipId: await membershipIdFor(A.workspaceId, A.memberId),
      anchorType: "project",
      anchorId: id.grantedProject,
      grantedById: A.ownerId,
    },
  });
});

after(async () => {
  if (!configured) return;
  // Remove any object these tests stored, then the tenant.
  const rows = await observer.fileAsset.findMany({
    where: { workspaceId: A.workspaceId },
    select: { storageKey: true },
  });
  for (const row of rows) {
    try {
      await getStorage().deleteObject(row.storageKey);
    } catch {
      // A leftover object in a throwaway bucket is not a failure.
    }
  }
  await cleanupTenants([A]);
});

describe("a document on a project", { concurrency: false }, () => {
  test("request, upload, confirm, row", requirements, async () => {
    await resetRateLimit("upload", { user: A.ownerId, workspace: A.workspaceId });

    const asked = await request(A.ownerId, id.grantedProject);
    assert.ok(asked.ok, `requestUpload refused: ${asked.ok ? "" : asked.error}`);
    const ticket = asked.data as Ticket;

    // The contract tells the browser what to do and nothing about where.
    assert.equal(ticket.upload.method, "PUT");
    assert.ok(ticket.upload.url.includes("X-Amz-Signature"), "not a presigned URL");

    const stored = await upload(ticket, PDF);
    assert.ok(stored.ok, `the direct upload failed: ${stored.status}`);

    const confirmed = await confirm(A.ownerId, ticket.uploadToken);
    assert.ok(confirmed.ok, `confirmUpload refused: ${confirmed.ok ? "" : confirmed.error}`);

    const rows = await filesOn(id.grantedProject);
    assert.equal(rows.length, 1, "expected exactly one file row");
    assert.equal(rows[0]!.name, "q3-proposal.pdf");
    assert.equal(rows[0]!.mimeType, "application/pdf");
    // The size written is the one storage reported, not the one requested.
    assert.equal(rows[0]!.sizeBytes, PDF.length);
    assert.equal(rows[0]!.uploaderId, A.ownerId);

    // And the event seam fired.
    const events = await observer.domainEvent.findMany({
      where: { workspaceId: A.workspaceId, name: "file.uploaded" },
      select: { entityId: true, entityType: true },
    });
    assert.equal(events.length, 1, "no file.uploaded event was emitted");
    assert.equal(events[0]!.entityType, "fileAsset");
  });

  test("the storage key is server-generated and opaque", requirements, async () => {
    const rows = await filesOn(id.grantedProject);
    const key = rows[0]!.storageKey;

    // Workspace-prefixed, so a listing stays tenant-partitioned.
    assert.ok(key.startsWith(`workspaces/${A.workspaceId}/`), `key is not workspace-prefixed: ${key}`);
    // Random, not derived from the name the user chose — two uploads of the
    // same filename must not collide, and a key must not be guessable from it.
    assert.ok(!key.includes("q3-proposal"), `the display name leaked into the key: ${key}`);
    assert.match(key, /\/[0-9a-f-]{36}\.pdf$/, `key is not a uuid: ${key}`);
  });

  test("the object it points at really is there", requirements, async () => {
    const rows = await filesOn(id.grantedProject);
    const head = await getStorage().headObject(rows[0]!.storageKey);
    assert.ok(head, "the row names an object that does not exist");
    assert.equal(head.sizeBytes, PDF.length);
  });
});

describe("what a client can get away with between the two calls", { concurrency: false }, () => {
  test("a truthful preflight followed by a hostile upload is refused", requirements, async () => {
    // The whole point of confirming against bytes at rest. The client says
    // "this is a PDF" — truthfully, as far as the preflight can tell — obtains
    // a URL, and then stores HTML under it.
    await resetRateLimit("upload", { user: A.ownerId, workspace: A.workspaceId });

    const asked = await request(A.ownerId, id.ungrantedProject, { filename: "invoice.pdf" });
    assert.ok(asked.ok);
    const ticket = asked.data as Ticket;

    const stored = await upload(ticket, HTML);
    assert.ok(stored.ok, "setup failed: the hostile object was not stored");

    const confirmed = await confirm(A.ownerId, ticket.uploadToken);
    assert.ok(!confirmed.ok, "HTML masquerading as a PDF was accepted");
    assert.match(confirmed.error, /do not match its extension/);

    // No row, and no object left behind.
    assert.deepEqual(await filesOn(id.ungrantedProject), [], "a rejected upload created a row");
    const key = JSON.parse(
      Buffer.from(ticket.uploadToken.split(".")[0]!, "base64url").toString("utf8"),
    ).key as string;
    assert.equal(
      await getStorage().headObject(key),
      null,
      "the rejected object was left in storage",
    );
  });

  test("an object larger than the limit is refused and removed", requirements, async () => {
    // A presigned PUT cannot enforce a size ceiling: S3-style signatures do not
    // sign Content-Length and the browser controls the body. So the client
    // declares a small file, obtains a URL, and uploads a large one.
    await resetRateLimit("upload", { user: A.ownerId, workspace: A.workspaceId });

    const asked = await request(A.ownerId, id.ungrantedProject, { sizeBytes: PDF.length });
    assert.ok(asked.ok);
    const ticket = asked.data as Ticket;

    const oversized: Uint8Array<ArrayBuffer> = new Uint8Array(LIMITS.maxUploadBytes + 1024);
    oversized.set(PDF, 0); // a genuine PDF signature, so only the size is wrong

    const stored = await upload(ticket, oversized);
    assert.ok(stored.ok, "setup failed: the oversized object was not stored");

    const confirmed = await confirm(A.ownerId, ticket.uploadToken);
    assert.ok(!confirmed.ok, "an oversized object was accepted");
    assert.match(confirmed.error, /MB or smaller/);

    assert.deepEqual(await filesOn(id.ungrantedProject), [], "an oversized upload created a row");
    const key = JSON.parse(
      Buffer.from(ticket.uploadToken.split(".")[0]!, "base64url").toString("utf8"),
    ).key as string;
    assert.equal(await getStorage().headObject(key), null, "the oversized object was left in storage");
  });

  test("confirming without uploading anything is refused", requirements, async () => {
    await resetRateLimit("upload", { user: A.ownerId, workspace: A.workspaceId });
    const asked = await request(A.ownerId, id.ungrantedProject);
    assert.ok(asked.ok);

    const confirmed = await confirm(A.ownerId, (asked.data as Ticket).uploadToken);
    assert.ok(!confirmed.ok, "a row was created for an object that was never uploaded");
    assert.deepEqual(await filesOn(id.ungrantedProject), []);
  });

  test("a token cannot be edited to point at another project", requirements, async () => {
    await resetRateLimit("upload", { user: A.ownerId, workspace: A.workspaceId });
    const asked = await request(A.ownerId, id.ungrantedProject);
    assert.ok(asked.ok);
    const ticket = asked.data as Ticket;
    await upload(ticket, PDF);

    const [body, signature] = ticket.uploadToken.split(".") as [string, string];
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    payload.projectId = id.grantedProject;
    const forged = `${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${signature}`;

    const confirmed = await confirm(A.ownerId, forged);
    assert.ok(!confirmed.ok, "an edited upload token was accepted");

    await getStorage().deleteObject(payload.key);
  });

  test("a token cannot be replayed to record the same object twice", requirements, async () => {
    // A token is valid for its whole window. Without a guard, confirming twice
    // yields two rows for one object, and deleting either orphans the other.
    await resetRateLimit("upload", { user: A.ownerId, workspace: A.workspaceId });

    const asked = await request(A.ownerId, id.ungrantedProject);
    assert.ok(asked.ok);
    const ticket = asked.data as Ticket;
    assert.ok((await upload(ticket, PDF)).ok);

    const first = await confirm(A.ownerId, ticket.uploadToken);
    assert.ok(first.ok, `the first confirm failed: ${first.ok ? "" : first.error}`);

    const second = await confirm(A.ownerId, ticket.uploadToken);
    assert.ok(!second.ok, "a replayed token created a second row");
    assert.equal(second.category, "conflict");

    assert.equal(
      (await filesOn(id.ungrantedProject)).length,
      1,
      "one object ended up with more than one row",
    );

    // Tidy up so the cumulative assertion below still describes refusals only.
    const rows = await filesOn(id.ungrantedProject);
    await getStorage().deleteObject(rows[0]!.storageKey);
    await observer.fileAsset.deleteMany({ where: { id: rows[0]!.id } });
  });

  test("rejected uploads leave nothing behind", requirements, async () => {
    // The cumulative statement of the refusals above.
    assert.deepEqual(await filesOn(id.ungrantedProject), []);
  });
});

describe("the files flag", { concurrency: false }, () => {
  test("switching it off makes the action unreachable, not merely hidden", requirements, async () => {
    // A flag that only hides a button is not a control. This asserts the
    // capability itself disappears.
    await resetRateLimit("upload", { user: A.ownerId, workspace: A.workspaceId });
    await observer.featureFlag.updateMany({
      where: { key: "files", workspaceId: A.workspaceId },
      data: { enabled: false },
    });

    try {
      const asked = await request(A.ownerId, id.grantedProject);
      assert.ok(!asked.ok, "SECURITY FAILURE: uploads worked with the files flag off");
      assert.equal(asked.category, "forbidden");
    } finally {
      await observer.featureFlag.updateMany({
        where: { key: "files", workspaceId: A.workspaceId },
        data: { enabled: true },
      });
    }
  });
});

describe("who may put a document on a project", { concurrency: false }, () => {
  test("a restricted member may upload to work they were given", requirements, async () => {
    await resetRateLimit("upload", { user: A.memberId, workspace: A.workspaceId });

    const asked = await request(A.memberId, id.grantedProject);
    assert.ok(asked.ok, `a granted project was refused: ${asked.ok ? "" : asked.error}`);
    const ticket = asked.data as Ticket;

    assert.ok((await upload(ticket, PDF)).ok);
    const confirmed = await confirm(A.memberId, ticket.uploadToken);
    assert.ok(confirmed.ok, `confirm refused on granted work: ${confirmed.ok ? "" : confirmed.error}`);

    const rows = await filesOn(id.grantedProject);
    assert.ok(
      rows.some((r) => r.uploaderId === A.memberId),
      "the restricted member's file was not recorded",
    );
  });

  test("a restricted member may not request an upload on work they were not given", requirements, async () => {
    await resetRateLimit("upload", { user: A.memberId, workspace: A.workspaceId });

    const asked = await request(A.memberId, id.ungrantedProject);
    assert.ok(!asked.ok, "SECURITY FAILURE: an ungranted project accepted an upload request");
    // "Not found" rather than "forbidden": the existence of the project is
    // itself information this member is not entitled to.
    assert.equal(asked.category, "not_found");
  });

  test("a restricted member may not confirm onto work they were not given", requirements, async () => {
    // The dangerous case, and the reason confirmation re-authorises instead of
    // trusting the token: the owner legitimately obtains a token for a project
    // the restricted member cannot see, and the restricted member presents it.
    await resetRateLimit("upload", { user: A.ownerId, workspace: A.workspaceId });
    await resetRateLimit("upload", { user: A.memberId, workspace: A.workspaceId });

    const asked = await request(A.ownerId, id.ungrantedProject);
    assert.ok(asked.ok, "setup failed");
    const ticket = asked.data as Ticket;
    assert.ok((await upload(ticket, PDF)).ok, "setup failed: object not stored");

    const confirmed = await confirm(A.memberId, ticket.uploadToken);
    assert.ok(
      !confirmed.ok,
      "SECURITY FAILURE: a restricted member confirmed a file onto an ungranted project",
    );
    assert.equal(confirmed.category, "not_found");

    assert.deepEqual(
      await filesOn(id.ungrantedProject),
      [],
      "SECURITY FAILURE: a row exists on a project the actor could not see",
    );

    // The owner's legitimately stored object is still there; it was not the
    // restricted member's to destroy either.
    const key = JSON.parse(
      Buffer.from(ticket.uploadToken.split(".")[0]!, "base64url").toString("utf8"),
    ).key as string;
    assert.ok(await getStorage().headObject(key), "a refused confirm deleted someone else's object");
    await getStorage().deleteObject(key);
  });

  test("a full-workspace member may upload to any project", requirements, async () => {
    await resetRateLimit("upload", { user: A.ownerId, workspace: A.workspaceId });

    const asked = await request(A.ownerId, id.ungrantedProject);
    assert.ok(asked.ok, "a full-workspace member was refused");
    const ticket = asked.data as Ticket;
    assert.ok((await upload(ticket, PDF)).ok);

    const confirmed = await confirm(A.ownerId, ticket.uploadToken);
    assert.ok(confirmed.ok, `a full-workspace member could not confirm: ${confirmed.ok ? "" : confirmed.error}`);
    assert.equal((await filesOn(id.ungrantedProject)).length, 1);
  });

  test("a viewer may not upload at all", requirements, async () => {
    await resetRateLimit("upload", { user: A.viewerId, workspace: A.workspaceId });
    const asked = await request(A.viewerId, id.grantedProject);
    assert.ok(!asked.ok, "SECURITY FAILURE: a viewer was allowed to upload");
  });

  test("a member of another workspace cannot reach this project", requirements, async () => {
    const B = await createTenant("Outsider");
    try {
      await resetRateLimit("upload", { user: B.ownerId, workspace: B.workspaceId });
      const asked = await request(B.ownerId, id.grantedProject);
      assert.ok(!asked.ok, "SECURITY FAILURE: a foreign workspace obtained an upload URL");
      assert.equal(asked.category, "not_found");
    } finally {
      await cleanupTenants([B]);
    }
  });
});

describe("the upload rate limit", { concurrency: false }, () => {
  test("is actually enforced", requirements, async () => {
    // The `upload` policy has existed with no call site since it was written.
    // This is the test that makes it a control rather than a decoration:
    // 30 per user per hour.
    await resetRateLimit("upload", { user: A.ownerId, workspace: A.workspaceId });

    let refusal: { ok: boolean; error?: string; category?: string } | null = null;
    let allowed = 0;

    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await request(A.ownerId, id.grantedProject);
      if (result.ok) {
        allowed++;
        continue;
      }
      refusal = result;
      break;
    }

    assert.ok(refusal, "the upload limit never refused, after 40 attempts");
    assert.equal(refusal.category, "rate_limited", `refused for the wrong reason: ${refusal.error}`);
    assert.equal(allowed, 30, `expected 30 uploads before the limit, got ${allowed}`);

    await resetRateLimit("upload", { user: A.ownerId, workspace: A.workspaceId });
  });
});
