import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createTenant, cleanupTenants, db as observer, membershipIdFor, type Tenant } from "../helpers/fixtures";
import { requestUpload, confirmUpload, deleteFile, requestDocumentPreview } from "../../src/lib/actions/files";
import { GET as downloadDocument } from "../../src/app/api/files/[id]/download/route";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { resetRateLimit } from "../../src/lib/rate-limit";
import { getStorage } from "../../src/lib/storage";
import { LIMITS } from "../../src/lib/validation/limits";
import { isPostgres } from "../../src/lib/env";
import { withTenantContext } from "../../src/lib/tenant-db";
import { restrictedIdsFor } from "../../src/lib/auth/access";

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
/** Two full-workspace members, so "member" tests are not also "restricted" tests. */
const people = { plainMember: "", otherMember: "" };

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

  // `A.memberId` is the restricted one. Ownership rules have to be tested on
  // somebody whose scope is not also under test, so two ordinary members join.
  people.plainMember = await addMember("plain");
  people.otherMember = await addMember("other");
});

/** A full-workspace member with the `member` role. */
async function addMember(label: string): Promise<string> {
  const user = await observer.user.create({
    data: {
      email: `docs-${label}-${randomUUID().slice(0, 8)}@test.local`,
      name: `${label} Member`,
      passwordHash: "not-used-by-the-in-process-test-identity",
      emailVerifiedAt: new Date(),
    },
    select: { id: true },
  });
  await observer.workspaceMember.create({
    data: { workspaceId: A.workspaceId, userId: user.id, role: "member" },
  });
  return user.id;
}

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
  // The two extra members are not part of the fixture tenant, so they are not
  // swept up by cleanupTenants.
  await observer.user.deleteMany({
    where: { id: { in: [people.plainMember, people.otherMember].filter(Boolean) } },
  });
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

describe("one object, one row", { concurrency: false }, () => {
  test("the database refuses a second row for the same stored object", requirements, async () => {
    // The application guard is bypassed entirely here, on purpose. This asks
    // one question and no other: does the database hold the invariant when
    // nothing in the application is standing in front of it?
    const key = `workspaces/${A.workspaceId}/${randomUUID()}.pdf`;
    const row = () => ({
      workspaceId: A.workspaceId,
      projectId: id.grantedProject,
      name: "duplicate.pdf",
      mimeType: "application/pdf",
      sizeBytes: PDF.length,
      storageKey: key,
    });

    const first = await observer.fileAsset.create({ data: row(), select: { id: true } });
    try {
      let code: string | undefined;
      await assert.rejects(
        () => observer.fileAsset.create({ data: row(), select: { id: true } }),
        (error: { code?: string }) => {
          code = error.code;
          return true;
        },
        "the database accepted two rows for one stored object",
      );
      assert.equal(code, "P2002", `refused, but not by a unique constraint (code ${code})`);

      assert.equal(
        (await observer.fileAsset.findMany({ where: { storageKey: key } })).length,
        1,
        "more than one row survived",
      );
    } finally {
      await observer.fileAsset.deleteMany({ where: { id: first.id } });
    }
  });

  test("two confirmations racing create exactly one row", requirements, async () => {
    // End to end, through the real actions, started together. Either the
    // application guard wins the race or the unique index does; the caller
    // cannot tell which, and must not be able to.
    await resetRateLimit("upload", { user: A.ownerId, workspace: A.workspaceId });

    const asked = await request(A.ownerId, id.grantedProject);
    assert.ok(asked.ok);
    const ticket = asked.data as Ticket;
    assert.ok((await upload(ticket, PDF)).ok, "setup failed: object not stored");

    const [a, b] = await Promise.all([
      confirm(A.ownerId, ticket.uploadToken),
      confirm(A.ownerId, ticket.uploadToken),
    ]);

    const succeeded = [a, b].filter((r) => r.ok);
    const refused = [a, b].filter((r) => !r.ok);

    assert.equal(succeeded.length, 1, "both concurrent confirmations succeeded");
    assert.equal(refused.length, 1, "neither concurrent confirmation succeeded");
    assert.equal(
      refused[0]!.category,
      "conflict",
      `the loser refused for the wrong reason: ${refused[0]!.error}`,
    );
    // Whichever mechanism refused, the caller gets the same sentence — so a
    // race and an ordinary replay are indistinguishable from outside.
    assert.match(refused[0]!.error, /already been added/);

    const key = JSON.parse(
      Buffer.from(ticket.uploadToken.split(".")[0]!, "base64url").toString("utf8"),
    ).key as string;

    const rows = await observer.fileAsset.findMany({ where: { storageKey: key }, select: { id: true } });
    assert.equal(rows.length, 1, `one object ended up with ${rows.length} rows`);

    // The loser must not have deleted the winner's bytes.
    assert.ok(
      await getStorage().headObject(key),
      "the losing confirmation removed the object the surviving row points at",
    );

    await getStorage().deleteObject(key);
    await observer.fileAsset.deleteMany({ where: { storageKey: key } });
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

/** Uploads one document as a given user and returns its row id. */
async function uploadAs(userId: string, projectId: string, filename = "contract.pdf"): Promise<string> {
  await resetRateLimit("upload", { user: userId, workspace: A.workspaceId });
  const asked = await request(userId, projectId, { filename });
  assert.ok(asked.ok, `setup: requestUpload refused (${asked.ok ? "" : asked.error})`);
  const ticket = asked.data as Ticket;
  assert.ok((await upload(ticket, PDF)).ok, "setup: the object was not stored");
  const confirmed = await confirm(userId, ticket.uploadToken);
  assert.ok(confirmed.ok, `setup: confirmUpload refused (${confirmed.ok ? "" : confirmed.error})`);
  return (confirmed.data as { id: string }).id;
}

async function rowExists(fileId: string): Promise<boolean> {
  return (await observer.fileAsset.count({ where: { id: fileId } })) > 0;
}

async function keyOf(fileId: string): Promise<string> {
  const row = await observer.fileAsset.findUnique({ where: { id: fileId }, select: { storageKey: true } });
  return row!.storageKey;
}

describe("who may delete a document", { concurrency: false }, () => {
  test("a member may delete one they uploaded", requirements, async () => {
    // The reason this branch exists at all: `member` does not hold
    // `record:delete`, so without it someone could attach the wrong contract
    // and have no way to take it back — and documents have no Trash.
    const fileId = await uploadAs(people.plainMember, id.grantedProject, "mine.pdf");
    const key = await keyOf(fileId);

    const result = await runAsTestIdentity(people.plainMember, () => deleteFile(fileId, "mine.pdf"));
    assert.ok(result.ok, `a member could not delete their own document: ${result.ok ? "" : result.error}`);

    assert.equal(await rowExists(fileId), false, "the row survived");
    assert.equal(await getStorage().headObject(key), null, "the object survived");
  });

  test("a member may NOT delete another member's document", requirements, async () => {
    const fileId = await uploadAs(people.plainMember, id.grantedProject, "not-yours.pdf");

    const result = await runAsTestIdentity(people.otherMember, () => deleteFile(fileId, "not-yours.pdf"));

    assert.ok(!result.ok, "SECURITY FAILURE: a member deleted somebody else's document");
    assert.equal(result.category, "forbidden");
    assert.ok(await rowExists(fileId), "the row was removed anyway");

    // And the object is untouched — a refused delete must not destroy bytes.
    assert.ok(await getStorage().headObject(await keyOf(fileId)), "a refused delete removed the object");

    await runAsTestIdentity(A.ownerId, () => deleteFile(fileId, "not-yours.pdf"));
  });

  test("a manager-or-above may delete a document they did not upload", requirements, async () => {
    // The owner holds `record:delete`, which is the manager+ branch.
    const fileId = await uploadAs(people.plainMember, id.grantedProject, "theirs.pdf");
    const key = await keyOf(fileId);

    const result = await runAsTestIdentity(A.ownerId, () => deleteFile(fileId, "theirs.pdf"));

    assert.ok(result.ok, `an owner could not delete a member's document: ${result.ok ? "" : result.error}`);
    assert.equal(await rowExists(fileId), false);
    assert.equal(await getStorage().headObject(key), null);
  });

  test("a viewer may not delete anything", requirements, async () => {
    const fileId = await uploadAs(people.plainMember, id.grantedProject, "viewer-cannot.pdf");
    const result = await runAsTestIdentity(A.viewerId, () => deleteFile(fileId, "viewer-cannot.pdf"));

    assert.ok(!result.ok, "SECURITY FAILURE: a viewer deleted a document");
    assert.ok(await rowExists(fileId), "the row was removed anyway");

    await runAsTestIdentity(A.ownerId, () => deleteFile(fileId, "viewer-cannot.pdf"));
  });
});

describe("confirming a deletion", { concurrency: false }, () => {
  test("the wrong filename is refused, and nothing is destroyed", requirements, async () => {
    const fileId = await uploadAs(people.plainMember, id.grantedProject, "precise.pdf");
    const key = await keyOf(fileId);

    const result = await runAsTestIdentity(people.plainMember, () => deleteFile(fileId, "precise"));

    assert.ok(!result.ok, "a mistyped confirmation deleted the document");
    assert.equal(result.category, "validation");
    assert.ok(await rowExists(fileId), "the row was removed on a failed confirmation");
    assert.ok(await getStorage().headObject(key), "the object was removed on a failed confirmation");

    await runAsTestIdentity(people.plainMember, () => deleteFile(fileId, "precise.pdf"));
  });

  test("the confirmation is checked on the server, not only in the dialog", requirements, async () => {
    // An empty string is what a direct call to the action would send.
    const fileId = await uploadAs(people.plainMember, id.grantedProject, "server-checks.pdf");
    const result = await runAsTestIdentity(people.plainMember, () => deleteFile(fileId, ""));

    assert.ok(!result.ok, "SECURITY FAILURE: a deletion with no confirmation succeeded");
    assert.ok(await rowExists(fileId));

    await runAsTestIdentity(people.plainMember, () => deleteFile(fileId, "server-checks.pdf"));
  });
});

describe("deletion under record scope", { concurrency: false }, () => {
  test("a restricted member may delete their own document on granted work", requirements, async () => {
    const fileId = await uploadAs(A.memberId, id.grantedProject, "granted-mine.pdf");
    const key = await keyOf(fileId);

    const result = await runAsTestIdentity(A.memberId, () => deleteFile(fileId, "granted-mine.pdf"));

    assert.ok(result.ok, `a restricted member could not delete their own file: ${result.ok ? "" : result.error}`);
    assert.equal(await rowExists(fileId), false);
    assert.equal(await getStorage().headObject(key), null);
  });

  test("a restricted member cannot use a known file id from ungranted work", requirements, async () => {
    // The id is handed to them directly, which is the whole point: record scope
    // must not depend on ids being unguessable.
    const fileId = await uploadAs(A.ownerId, id.ungrantedProject, "not-for-them.pdf");
    const key = await keyOf(fileId);

    const result = await runAsTestIdentity(A.memberId, () => deleteFile(fileId, "not-for-them.pdf"));

    assert.ok(!result.ok, "SECURITY FAILURE: a restricted member deleted a file on ungranted work");
    // "Not found" rather than "forbidden": the document's existence is itself
    // something this member is not entitled to learn.
    assert.equal(result.category, "not_found");
    assert.ok(await rowExists(fileId), "the row was removed anyway");
    assert.ok(await getStorage().headObject(key), "the object was removed anyway");

    await runAsTestIdentity(A.ownerId, () => deleteFile(fileId, "not-for-them.pdf"));
  });
});

describe("deletion failure semantics", { concurrency: false }, () => {
  test("a storage failure after the row is gone leaves no visible document", requirements, async () => {
    // A key past S3's 1024-byte limit: the store answers DELETE with 400, so
    // `deleteObject` throws for real rather than through a stub. The row is
    // created directly because no upload could produce a key this shape.
    const doomedKey = `workspaces/${A.workspaceId}/${"x".repeat(1200)}.pdf`;
    const file = await observer.fileAsset.create({
      data: {
        workspaceId: A.workspaceId,
        projectId: id.grantedProject,
        name: "orphan-maker.pdf",
        mimeType: "application/pdf",
        sizeBytes: PDF.length,
        storageKey: doomedKey,
        uploaderId: people.plainMember,
      },
      select: { id: true },
    });

    const result = await runAsTestIdentity(people.plainMember, () =>
      deleteFile(file.id, "orphan-maker.pdf"),
    );

    // The person is told it is gone, because from where they stand it is.
    assert.ok(result.ok, `the failure was surfaced to the user: ${result.ok ? "" : result.error}`);
    assert.equal(await rowExists(file.id), false, "the row was resurrected by a storage failure");

    // And the orphan is recorded where an operator would look for it.
    const entry = await observer.auditLog.findFirst({
      where: { entityId: file.id, action: "record.deleted" },
      select: { metadata: true },
    });
    assert.ok(entry, "no audit entry for the deletion");
    const metadata = JSON.parse(entry.metadata ?? "{}") as { orphanedObject?: boolean };
    assert.equal(metadata.orphanedObject, true, "the orphaned object was not recorded");
  });

  test("authorisation and confirmation are decided before storage is touched", requirements, async () => {
    // Both refusals above already assert the object survives. This states the
    // ordering as its own claim: a document refused for *either* reason keeps
    // its bytes, so no refused request can destroy anything.
    const fileId = await uploadAs(people.plainMember, id.grantedProject, "ordering.pdf");
    const key = await keyOf(fileId);

    const wrongPerson = await runAsTestIdentity(people.otherMember, () => deleteFile(fileId, "ordering.pdf"));
    assert.ok(!wrongPerson.ok);
    assert.ok(await getStorage().headObject(key), "an unauthorised delete removed the object");

    const wrongName = await runAsTestIdentity(people.plainMember, () => deleteFile(fileId, "nope.pdf"));
    assert.ok(!wrongName.ok);
    assert.ok(await getStorage().headObject(key), "an unconfirmed delete removed the object");

    await runAsTestIdentity(people.plainMember, () => deleteFile(fileId, "ordering.pdf"));
  });
});

describe("downloading a document", { concurrency: false }, () => {
  const call = (userId: string, fileId: string) =>
    runAsTestIdentity(userId, () =>
      downloadDocument(new Request(`http://localhost/api/files/${fileId}/download`) as never, {
        params: Promise.resolve({ id: fileId }),
      }),
    );

  test("redirects to storage, as an attachment, without proxying bytes", requirements, async () => {
    const fileId = await uploadAs(people.plainMember, id.grantedProject, "readable.pdf");

    const response = await call(people.plainMember, fileId);
    if (response.status !== 302) {
      // The reason matters more than the number when this fails.
      assert.fail(`expected a redirect, got ${response.status}: ${await response.text()}`);
    }

    const location = response.headers.get("location") ?? "";
    assert.ok(location.includes("X-Amz-Signature"), "the redirect target is not a presigned URL");

    // Short-lived. A signed URL is a bearer token for one object while it
    // lasts, so its life is the mitigation.
    assert.equal(
      new URL(location).searchParams.get("X-Amz-Expires"),
      "60",
      "the download URL is not short-lived",
    );
    assert.equal(
      response.headers.get("cache-control"),
      "private, no-store",
      "the redirect could be cached by a shared cache",
    );
    const disposition = new URL(location).searchParams.get("response-content-disposition") ?? "";
    assert.match(
      disposition,
      /^attachment; filename="readable\.pdf"$/,
      `forced download was not preserved: ${disposition || "(no disposition parameter)"}`,
    );
    // The body carries no file: the browser is sent to storage.
    assert.equal((await response.text()).length, 0, "the route streamed the file itself");

    await runAsTestIdentity(people.plainMember, () => deleteFile(fileId, "readable.pdf"));
  });

  test("a restricted member cannot download from work they were not given", requirements, async () => {
    const fileId = await uploadAs(A.ownerId, id.ungrantedProject, "hidden.pdf");

    const response = await call(A.memberId, fileId);
    assert.ok(response.status >= 400, "SECURITY FAILURE: an ungranted document was downloadable");
    assert.equal(response.status, 404);

    await runAsTestIdentity(A.ownerId, () => deleteFile(fileId, "hidden.pdf"));
  });
});

describe("the files flag governs every entry point", { concurrency: false }, () => {
  test("upload, download and delete all refuse while it is off", requirements, async () => {
    const fileId = await uploadAs(people.plainMember, id.grantedProject, "flagged.pdf");

    await observer.featureFlag.updateMany({
      where: { key: "files", workspaceId: A.workspaceId },
      data: { enabled: false },
    });

    try {
      const upload = await request(people.plainMember, id.grantedProject);
      assert.ok(!upload.ok, "uploads worked with the flag off");

      const removal = await runAsTestIdentity(people.plainMember, () => deleteFile(fileId, "flagged.pdf"));
      assert.ok(!removal.ok, "deletion worked with the flag off");
      assert.ok(await rowExists(fileId), "a flag-refused delete still removed the row");

      const download = await runAsTestIdentity(people.plainMember, () =>
        downloadDocument(new Request(`http://localhost/api/files/${fileId}/download`) as never, {
          params: Promise.resolve({ id: fileId }),
        }),
      );
      assert.equal(download.status, 403, "downloads worked with the flag off");
      // And crucially: no signed URL was minted before the refusal, so a
      // flag-off download cannot be completed by following a redirect.
      assert.equal(
        download.headers.get("location"),
        null,
        "a presigned URL was issued despite the flag being off",
      );
    } finally {
      await observer.featureFlag.updateMany({
        where: { key: "files", workspaceId: A.workspaceId },
        data: { enabled: true },
      });
    }

    await runAsTestIdentity(people.plainMember, () => deleteFile(fileId, "flagged.pdf"));
  });
});

describe("why the download route opens a tenant context", { concurrency: false }, () => {
  test("a workspace feature flag is unreadable without one", requirements, async () => {
    // The mechanism behind a real bug in this branch. `FeatureFlag`'s policy is
    //
    //   USING ("workspaceId" IS NULL OR app_can_see_workspace("workspaceId"))
    //
    // so a workspace override is visible only when `app.workspace_ids` is set.
    // Outside a context that GUC is unset, the row is filtered, and `isEnabled`
    // falls back to the built-in default — `files: false`. The feature then
    // reports itself disabled for everyone, with no error to explain it.
    //
    // The server actions never hit this because `recordAction` has already
    // opened a context around them. A route handler has to do it deliberately,
    // and this is the test that says why.
    const { isEnabled } = await import("../../src/lib/flags");

    const outside = await isEnabled("files", A.workspaceId);
    const inside = await withTenantContext(
      {
        workspaceIds: [A.workspaceId],
        userId: A.ownerId,
        restrictedWorkspaceIds: restrictedIdsFor([], [A.workspaceId]),
      },
      () => isEnabled("files", A.workspaceId),
    );

    assert.equal(inside, true, "the flag was not readable even inside a tenant context");
    assert.equal(
      outside,
      false,
      "the flag was readable outside a tenant context — the route's context may no longer be load-bearing",
    );
  });
});

describe("the Project page's own flag resolution", { concurrency: false }, () => {
  /**
   * The production regression, reproduced.
   *
   * The Documents panel did not appear on a project whose workspace had
   * `files = true`. Nothing was wrong with the flag row, the workspace id, the
   * conditional, or the deployed build. The page read the flag *after*
   * `getProject` had opened and closed its own tenant context, so
   * `app.workspace_ids` was unset, `FeatureFlag`'s policy filtered the override,
   * and `isEnabled` fell back to the built-in default of `false`.
   *
   * It reached production because the browser suite runs on SQLite, which has no
   * row-level security: the row was readable there and the panel rendered. Only
   * PostgreSQL can observe this, so the test lives here.
   *
   * The two assertions are deliberately opposed. One proves the page now works.
   * The other proves it works because the page *earns* a context — not because
   * the boundary was loosened to make the first one pass.
   */
  test("resolves a workspace override the way the page does", requirements, async () => {
    const { getProject } = await import("../../src/lib/data/projects");
    const { isEnabled } = await import("../../src/lib/flags");

    const read = {
      workspaceIds: [A.workspaceId],
      userId: A.ownerId,
      restrictedWorkspaceIds: [],
    };

    await runAsTestIdentity(A.ownerId, async () => {
      // Step one, exactly as the page does it: this opens a tenant context and
      // closes it again on return.
      const project = await getProject(read, id.grantedProject);
      assert.ok(project, "setup: the project did not resolve");
      assert.equal(project.workspaceId, A.workspaceId);

      // Step two as it shipped: bare, with no context left open. This is the
      // bug, and it must keep reading false — if it ever returns true, the
      // policy has been loosened and the wrapper below is no longer doing
      // anything.
      assert.equal(
        await isEnabled("files", project.workspaceId),
        false,
        "the workspace override was readable with no tenant context — the RLS boundary has been weakened",
      );

      // Step two as fixed: inside the context this request already earned by
      // resolving the project under RLS.
      const filesEnabled = await withTenantContext(
        {
          workspaceIds: [project.workspaceId],
          userId: A.ownerId,
          restrictedWorkspaceIds: restrictedIdsFor([], [project.workspaceId]),
        },
        () => isEnabled("files", project.workspaceId),
      );

      assert.equal(
        filesEnabled,
        true,
        "the page's flag lookup still cannot see the workspace override — the Documents panel would not render",
      );
    });
  });

  test("every flag lookup on a render surface sits inside a tenant context", async () => {
    /**
     * A source assertion, because that is where this rule actually lives.
     *
     * The test above proves the *mechanism* — a context makes the override
     * visible, and its absence does not. It cannot prove the page still uses
     * it: revert the page and that test keeps passing while production breaks
     * again in exactly the same way.
     *
     * So this reads the page and asserts the shape. A workspace-scoped
     * `isEnabled` on a page that never opens a context resolves to the built-in
     * default and hides the feature with no error anywhere.
     *
     * Deliberately not engine-gated: the source is the same on both engines,
     * and this is the assertion that has to hold on the one that does not have
     * row-level security to reveal the mistake.
     */
    const { readFileSync } = await import("node:fs");
    const page = "src/app/(app)/projects/[id]/page.tsx";
    const source = readFileSync(page, "utf8");

    const looksUpAFlag = /isEnabled\(\s*"[a-zA-Z]+"\s*,\s*project\.workspaceId/.test(source);
    assert.ok(looksUpAFlag, `${page} no longer resolves a workspace-scoped flag — update this test`);

    // The lookup must be an argument to withTenantContext, not a bare call.
    const wrapped = /withTenantContext\(\s*\{[\s\S]{0,400}?\},\s*\(\)\s*=>\s*isEnabled\(/.test(source);
    assert.ok(
      wrapped,
      `${page} reads a workspace-scoped feature flag outside withTenantContext. ` +
        "FeatureFlag is under RLS, so the override is filtered and isEnabled falls back " +
        "to the built-in default — the panel silently never renders.",
    );
  });
});

describe("previewing a document", { concurrency: false }, () => {
  /**
   * Preview is a separate capability from download, and it has to be
   * authorised on its own terms rather than inheriting download's.
   *
   * These run on PostgreSQL deliberately. The browser suite runs on SQLite,
   * which has no row-level security — it is the environment in which the
   * feature-flag defect passed CI and still broke production. Record scope and
   * the flag are both RLS-shaped, so they are proven here.
   */
  const preview = (userId: string, fileId: string) =>
    runAsTestIdentity(userId, () => requestDocumentPreview(fileId));

  test("returns short-lived signed access, and never the storage key", requirements, async () => {
    const fileId = await uploadAs(people.plainMember, id.grantedProject, "viewable.pdf");
    const key = await keyOf(fileId);

    const result = await preview(people.plainMember, fileId);
    assert.ok(result.ok, `preview refused: ${result.ok ? "" : result.error}`);

    const data = result.data;
    assert.equal(data.name, "viewable.pdf");
    assert.equal(data.mimeType, "application/pdf");
    assert.equal(data.sizeBytes, PDF.length);

    const url = new URL(data.url);
    assert.ok(url.searchParams.get("X-Amz-Signature"), "not a presigned URL");
    assert.equal(url.searchParams.get("X-Amz-Expires"), "60", "the preview URL is not short-lived");

    // The viewer needs bytes, not a durable handle on where they live.
    //
    // Note what this does *not* claim. A presigned URL necessarily contains the
    // object's path — that is what it addresses — so the key is inside `url` by
    // construction and asserting otherwise would be asserting a falsehood. The
    // property that matters is that it is not handed over as a field of its
    // own: there is nothing durable to keep, and the one reference that exists
    // is inside a signature that stops working in sixty seconds.
    assert.ok(!("storageKey" in data), "the response exposed the storage key as a field");
    const fields = Object.keys(data).sort();
    assert.deepEqual(
      fields,
      ["expiresAt", "mimeType", "name", "sizeBytes", "url"],
      "the preview response grew a field that was not reviewed",
    );
    assert.ok(new URL(data.url).pathname.includes(encodeURIComponent(key.split("/").pop()!)),
      "sanity: the signed URL should address the object it is for");

    // And the URL actually yields the document, so this is a working capability
    // rather than a well-formed string.
    const fetched = await fetch(data.url);
    assert.ok(fetched.ok, `the preview URL did not serve the object: ${fetched.status}`);
    assert.equal((await fetched.arrayBuffer()).byteLength, PDF.length);

    await runAsTestIdentity(people.plainMember, () => deleteFile(fileId, "viewable.pdf"));
  });

  test("a restricted member may preview work they were given", requirements, async () => {
    const fileId = await uploadAs(A.memberId, id.grantedProject, "granted-view.pdf");
    const result = await preview(A.memberId, fileId);
    assert.ok(result.ok, `a granted document could not be previewed: ${result.ok ? "" : result.error}`);
    await runAsTestIdentity(A.memberId, () => deleteFile(fileId, "granted-view.pdf"));
  });

  test("a restricted member cannot preview a known file id from ungranted work", requirements, async () => {
    // The id is handed over directly: record scope must not depend on ids
    // being unguessable.
    const fileId = await uploadAs(A.ownerId, id.ungrantedProject, "hidden-view.pdf");

    const result = await preview(A.memberId, fileId);
    assert.ok(!result.ok, "SECURITY FAILURE: an ungranted document was previewable");
    assert.equal(result.category, "not_found");

    await runAsTestIdentity(A.ownerId, () => deleteFile(fileId, "hidden-view.pdf"));
  });

  test("a member of another workspace cannot preview", requirements, async () => {
    const fileId = await uploadAs(people.plainMember, id.grantedProject, "not-theirs.pdf");
    const B = await createTenant("PreviewOutsider");
    try {
      const result = await preview(B.ownerId, fileId);
      assert.ok(!result.ok, "SECURITY FAILURE: a foreign workspace previewed a document");
      assert.equal(result.category, "not_found");
    } finally {
      await cleanupTenants([B]);
      await runAsTestIdentity(people.plainMember, () => deleteFile(fileId, "not-theirs.pdf"));
    }
  });

  test("a viewer may preview, because preview is a read", requirements, async () => {
    // record:view is the permission preview asks for, and a viewer holds it.
    const fileId = await uploadAs(people.plainMember, id.grantedProject, "read-only.pdf");
    const result = await preview(A.viewerId, fileId);
    assert.ok(result.ok, `a viewer could not preview: ${result.ok ? "" : result.error}`);
    await runAsTestIdentity(people.plainMember, () => deleteFile(fileId, "read-only.pdf"));
  });

  test("preview refuses while the files flag is off", requirements, async () => {
    const fileId = await uploadAs(people.plainMember, id.grantedProject, "flagged-view.pdf");
    await observer.featureFlag.updateMany({
      where: { key: "files", workspaceId: A.workspaceId },
      data: { enabled: false },
    });

    try {
      const result = await preview(people.plainMember, fileId);
      assert.ok(!result.ok, "preview worked with the flag off");
      assert.equal(result.category, "forbidden");
      // And no signed URL was minted before the refusal.
      assert.ok(!("url" in (result as object)), "a URL was returned despite the refusal");
    } finally {
      await observer.featureFlag.updateMany({
        where: { key: "files", workspaceId: A.workspaceId },
        data: { enabled: true },
      });
    }

    await runAsTestIdentity(people.plainMember, () => deleteFile(fileId, "flagged-view.pdf"));
  });
});
