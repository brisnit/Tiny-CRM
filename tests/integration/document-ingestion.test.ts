import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createTenant, cleanupTenants, db as observer, type Tenant } from "../helpers/fixtures";
import { buildPdf, KNOWN_GOOD_PAGES } from "../helpers/pdf-fixture";
import { withTenantContext } from "../../src/lib/tenant-db";
import { ingestFileAsset } from "../../src/lib/documents/ingest";
import { getDocumentIntelligence, getDocumentChunks } from "../../src/lib/documents/read";
import {
  StorageObjectMissing,
  StorageObjectTooLarge,
  type StorageDriver,
} from "../../src/lib/storage";

/**
 * Ingesting a document, end to end, minus the object store.
 *
 * The storage driver is injected — see the note on `ingestFileAsset`. Gates,
 * idempotency, failure states and classification have nothing to do with S3,
 * and binding them to a live endpoint would mean they ran only on a machine
 * with MinIO installed. The real driver is covered against a real endpoint in
 * tests/integration/storage.test.ts.
 *
 * Everything else is real: real tenants, real rows, real row-level security on
 * PostgreSQL, real PDFs built by tests/helpers/pdf-fixture.ts.
 */

let A: Tenant;

/** A storage driver that answers from memory, and can be told to misbehave. */
function fakeStorage(behaviour: {
  bytes?: Uint8Array;
  throws?: Error;
}): StorageDriver {
  const refuse = (): never => {
    throw new Error("not used by ingestion");
  };
  return {
    kind: "s3",
    createUploadUrl: refuse,
    createDownloadUrl: refuse,
    headObject: refuse,
    readRange: refuse,
    deleteObject: async () => {},
    readObject: async () => {
      if (behaviour.throws) throw behaviour.throws;
      return behaviour.bytes ?? new Uint8Array(0);
    },
  } as unknown as StorageDriver;
}

const goodPdf = () => new Uint8Array(buildPdf(KNOWN_GOOD_PAGES));

/** Runs inside a tenant context for A, the way a job does. */
async function inContext<T>(fn: () => Promise<T>): Promise<T> {
  return withTenantContext(
    { workspaceIds: [A.workspaceId], userId: A.ownerId, restrictedWorkspaceIds: [] },
    fn,
  );
}

/**
 * Runs a failing ingestion the way the job runner actually runs one, and
 * returns the error it raised.
 *
 * The distinction matters on PostgreSQL and is invisible on SQLite, which is
 * why it was worth getting right. `withTenantContext` opens a real transaction
 * there, so letting an exception escape it rolls back everything the callback
 * wrote — including the failure record the test then goes looking for.
 *
 * Production never does that. `runOneInContext` in src/lib/jobs.ts **catches**
 * the handler's error and returns `handleFailure(...)`; the callback returns
 * normally, the transaction commits, and the failure record survives. These
 * tests model that shape rather than one the runner never uses.
 *
 * `tests/integration/document-ingestion.test.ts` also drives the real runner
 * end to end below, so this is a convenience and not the only evidence.
 */
async function failingIngest(
  fileAssetId: string,
  storage: StorageDriver,
): Promise<unknown> {
  return inContext(async () => {
    try {
      await ingestFileAsset({ fileAssetId, workspaceId: A.workspaceId }, { storage });
      return null;
    } catch (error) {
      return error;
    }
  });
}

async function makeFile(name = "document.pdf", mimeType = "application/pdf"): Promise<string> {
  const file = await observer.fileAsset.create({
    data: {
      workspaceId: A.workspaceId,
      name,
      mimeType,
      sizeBytes: 2048,
      storageKey: `workspaces/${A.workspaceId}/${name}-${Date.now()}-${Math.random()}.pdf`,
      projectId: A.projectId,
    },
    select: { id: true },
  });
  return file.id;
}

/** Turns all three gates on for this workspace. Off is the shipped default. */
async function openGates() {
  for (const key of ["files", "ai", "documentAi"]) {
    await observer.featureFlag.upsert({
      where: { key_workspaceId: { key, workspaceId: A.workspaceId } },
      create: { key, enabled: true, workspaceId: A.workspaceId },
      update: { enabled: true },
    });
  }
}

async function setGate(key: string, enabled: boolean) {
  await observer.featureFlag.upsert({
    where: { key_workspaceId: { key, workspaceId: A.workspaceId } },
    create: { key, enabled, workspaceId: A.workspaceId },
    update: { enabled },
  });
}

before(async () => {
  A = await createTenant("DocIngest");
});

after(async () => {
  await cleanupTenants([A]);
  await observer.$disconnect();
});

beforeEach(async () => {
  await openGates();
});

describe("the three gates", () => {
  test("documentAi off means nothing is read and nothing is written", async () => {
    await setGate("documentAi", false);
    const fileId = await makeFile();

    const outcome = await inContext(() =>
      ingestFileAsset(
        { fileAssetId: fileId, workspaceId: A.workspaceId },
        { storage: fakeStorage({ throws: new Error("storage must not be touched") }) },
      ),
    );

    assert.deepEqual(outcome, { ingested: false, reason: "gated" });
    assert.equal(
      await observer.documentIngestion.count({ where: { fileAssetId: fileId } }),
      0,
      "a gated workspace still got an ingestion row",
    );
  });

  test("files off is enough to stop it", async () => {
    await setGate("files", false);
    const fileId = await makeFile();
    const outcome = await inContext(() =>
      ingestFileAsset({ fileAssetId: fileId, workspaceId: A.workspaceId }, { storage: fakeStorage({ bytes: goodPdf() }) }),
    );
    assert.deepEqual(outcome, { ingested: false, reason: "gated" });
  });

  test("ai off is enough to stop it", async () => {
    await setGate("ai", false);
    const fileId = await makeFile();
    const outcome = await inContext(() =>
      ingestFileAsset({ fileAssetId: fileId, workspaceId: A.workspaceId }, { storage: fakeStorage({ bytes: goodPdf() }) }),
    );
    assert.deepEqual(outcome, { ingested: false, reason: "gated" });
  });

  test("all three on lets it through", async () => {
    const fileId = await makeFile();
    const outcome = await inContext(() =>
      ingestFileAsset({ fileAssetId: fileId, workspaceId: A.workspaceId }, { storage: fakeStorage({ bytes: goodPdf() }) }),
    );
    assert.equal(outcome.ingested, true);
  });

  test("reading a flag with no tenant context throws rather than defaulting", async () => {
    // The defect this codebase has now had three times. Outside a context the
    // workspace override is filtered by row-level security and isEnabled falls
    // back to the built-in default — silently. This refuses instead.
    const fileId = await makeFile();
    await assert.rejects(
      () =>
        // Deliberately not wrapped in inContext().
        ingestFileAsset(
          { fileAssetId: fileId, workspaceId: A.workspaceId },
          { storage: fakeStorage({ bytes: goodPdf() }) },
        ),
      (error: unknown) => {
        // The user-facing message is deliberately generic; the diagnosis lives
        // in `internal`, which is never serialised to a client.
        assert.ok(error instanceof Error && error.name === "AppError", `threw ${String(error)}`);
        const internal = String((error as { internal?: unknown }).internal ?? "");
        assert.match(
          internal,
          /tenant context/i,
          "ingestion read a workspace-scoped flag with no tenant context",
        );
        return true;
      },
    );
  });
});

describe("a successful ingestion", () => {
  test("records status, counts and chunks with page provenance", async () => {
    const fileId = await makeFile();

    const outcome = await inContext(() =>
      ingestFileAsset({ fileAssetId: fileId, workspaceId: A.workspaceId }, { storage: fakeStorage({ bytes: goodPdf() }) }),
    );

    assert.equal(outcome.ingested && outcome.status, "ready");

    const summary = await inContext(() => getDocumentIntelligence(fileId, A.workspaceId));
    assert.ok(summary);
    assert.equal(summary.status, "ready");
    assert.equal(summary.pageCount, 3);
    assert.ok((summary.charCount ?? 0) > 0);
    assert.equal(summary.errorCode, null);
    assert.ok(summary.finishedAt instanceof Date);

    const chunks = await inContext(() => getDocumentChunks(fileId, A.workspaceId));
    assert.ok(chunks.length > 0);
    assert.deepEqual(chunks.map((c) => c.ordinal), chunks.map((_, i) => i));
    for (const chunk of chunks) {
      assert.ok(chunk.pageStart >= 1 && chunk.pageEnd <= 3, "a chunk claims a page the document lacks");
    }
  });

  test("stores no storage key, bucket or URL anywhere in the intelligence rows", async () => {
    const fileId = await makeFile();
    await inContext(() =>
      ingestFileAsset({ fileAssetId: fileId, workspaceId: A.workspaceId }, { storage: fakeStorage({ bytes: goodPdf() }) }),
    );

    const file = await observer.fileAsset.findUniqueOrThrow({
      where: { id: fileId },
      select: { storageKey: true },
    });
    const rows = JSON.stringify([
      await observer.documentIngestion.findFirst({ where: { fileAssetId: fileId } }),
      await observer.documentChunk.findMany({ where: { fileAssetId: fileId } }),
    ]);

    assert.ok(!rows.includes(file.storageKey), "the storage key leaked into an intelligence row");
    assert.ok(!/https?:\/\//.test(rows), "a URL leaked into an intelligence row");
    assert.ok(!/X-Amz/i.test(rows), "a signed-request artefact leaked into an intelligence row");
  });
});

describe("idempotency", () => {
  test("duplicate delivery does not duplicate chunks", async () => {
    const fileId = await makeFile();
    const storage = fakeStorage({ bytes: goodPdf() });

    const first = await inContext(() => ingestFileAsset({ fileAssetId: fileId, workspaceId: A.workspaceId }, { storage }));
    const second = await inContext(() => ingestFileAsset({ fileAssetId: fileId, workspaceId: A.workspaceId }, { storage }));

    assert.equal(first.ingested && first.chunks, second.ingested && second.chunks);

    const rows = await observer.documentChunk.count({ where: { fileAssetId: fileId } });
    assert.equal(rows, first.ingested ? first.chunks : -1, "a redelivery doubled the chunk set");

    assert.equal(
      await observer.documentIngestion.count({ where: { fileAssetId: fileId } }),
      1,
      "a redelivery created a second ingestion row",
    );
  });

  test("reprocessing the same bytes produces identical chunks", async () => {
    const fileId = await makeFile();
    const storage = fakeStorage({ bytes: goodPdf() });

    await inContext(() => ingestFileAsset({ fileAssetId: fileId, workspaceId: A.workspaceId }, { storage }));
    const before = await observer.documentChunk.findMany({
      where: { fileAssetId: fileId },
      orderBy: { ordinal: "asc" },
      select: { ordinal: true, text: true, pageStart: true, pageEnd: true },
    });

    await inContext(() => ingestFileAsset({ fileAssetId: fileId, workspaceId: A.workspaceId }, { storage }));
    const after = await observer.documentChunk.findMany({
      where: { fileAssetId: fileId },
      orderBy: { ordinal: "asc" },
      select: { ordinal: true, text: true, pageStart: true, pageEnd: true },
    });

    assert.deepEqual(after, before, "reprocessing produced a different chunk set");
  });

  test("counts attempts across runs", async () => {
    const fileId = await makeFile();
    const storage = fakeStorage({ bytes: goodPdf() });
    await inContext(() => ingestFileAsset({ fileAssetId: fileId, workspaceId: A.workspaceId }, { storage }));
    await inContext(() => ingestFileAsset({ fileAssetId: fileId, workspaceId: A.workspaceId }, { storage }));

    const row = await observer.documentIngestion.findFirstOrThrow({ where: { fileAssetId: fileId } });
    assert.equal(row.attempts, 2);
  });
});

describe("failure leaves an intelligible state", () => {
  test("a storage outage is failed, retryable, with no chunks", async () => {
    const fileId = await makeFile();

    const error = await failingIngest(fileId, fakeStorage({ throws: new Error("connection reset") }));
    assert.ok(error instanceof Error, "ingestion did not raise for the job runner to retry");

    const row = await observer.documentIngestion.findFirstOrThrow({ where: { fileAssetId: fileId } });
    assert.equal(row.status, "failed");
    assert.equal(row.errorCode, "internal");
    // Null, not 0: nothing has ever been extracted from this document, which is
    // a different statement from "extraction produced no chunks".
    assert.equal(row.chunkCount, null);
    assert.equal(await observer.documentChunk.count({ where: { fileAssetId: fileId } }), 0);
  });

  test("an oversized object is unsupported, not retried forever", async () => {
    const fileId = await makeFile();

    const outcome = await inContext(() =>
      ingestFileAsset(
        { fileAssetId: fileId, workspaceId: A.workspaceId },
        { storage: fakeStorage({ throws: new StorageObjectTooLarge("k", 99_000_000, 26_214_400) }) },
      ),
    );

    assert.equal(outcome.ingested && outcome.status, "unsupported");
    const row = await observer.documentIngestion.findFirstOrThrow({ where: { fileAssetId: fileId } });
    assert.equal(row.status, "unsupported");
    assert.equal(row.errorCode, "too_large");
  });

  test("a missing object is a storage problem, not a document problem", async () => {
    const fileId = await makeFile();
    const error = await failingIngest(fileId, fakeStorage({ throws: new StorageObjectMissing("k") }));
    assert.ok(error instanceof Error);
    const row = await observer.documentIngestion.findFirstOrThrow({ where: { fileAssetId: fileId } });
    assert.equal(row.errorCode, "storage_unavailable");
    assert.equal(row.status, "failed");
  });

  test("a malformed document is unsupported and says why", async () => {
    const fileId = await makeFile();
    const outcome = await inContext(() =>
      ingestFileAsset(
        { fileAssetId: fileId, workspaceId: A.workspaceId },
        { storage: fakeStorage({ bytes: new Uint8Array([1, 2, 3, 4, 5, 6]) }) },
      ),
    );

    assert.equal(outcome.ingested && outcome.status, "unsupported");
    const row = await observer.documentIngestion.findFirstOrThrow({ where: { fileAssetId: fileId } });
    assert.equal(row.errorCode, "unsupported_type");
  });

  test("a failure then a success leaves a clean ready state", async () => {
    const fileId = await makeFile();

    await failingIngest(fileId, fakeStorage({ throws: new Error("transient") }));

    const outcome = await inContext(() =>
      ingestFileAsset({ fileAssetId: fileId, workspaceId: A.workspaceId }, { storage: fakeStorage({ bytes: goodPdf() }) }),
    );

    assert.equal(outcome.ingested && outcome.status, "ready");
    const row = await observer.documentIngestion.findFirstOrThrow({ where: { fileAssetId: fileId } });
    assert.equal(row.status, "ready");
    assert.equal(row.errorCode, null, "a stale error code survived a successful retry");
    assert.ok((row.chunkCount ?? 0) > 0);
  });

  test("never leaves half a chunk set behind a ready status", async () => {
    // A document that succeeds, then a reprocess that fails. The old chunks may
    // survive — that is the previous good state — but the status must not claim
    // a result the chunks do not support.
    const fileId = await makeFile();
    await inContext(() =>
      ingestFileAsset({ fileAssetId: fileId, workspaceId: A.workspaceId }, { storage: fakeStorage({ bytes: goodPdf() }) }),
    );

    await failingIngest(fileId, fakeStorage({ throws: new Error("died mid-run") }));

    const row = await observer.documentIngestion.findFirstOrThrow({ where: { fileAssetId: fileId } });
    assert.notEqual(row.status, "ready", "a failed run left a ready status");
    assert.equal(row.status, "failed");
  });

  test("a failed reprocess does not claim an empty chunk set it still holds", async () => {
    // The bookkeeping bug this assertion exists for: writing chunkCount = 0 on
    // failure, while the previous run's rows are still in the table. The count
    // and the rows must agree, or anything reading the summary is misled about
    // what is actually retrievable.
    const fileId = await makeFile();
    await inContext(() =>
      ingestFileAsset({ fileAssetId: fileId, workspaceId: A.workspaceId }, { storage: fakeStorage({ bytes: goodPdf() }) }),
    );
    const before = await observer.documentIngestion.findFirstOrThrow({ where: { fileAssetId: fileId } });
    assert.ok((before.chunkCount ?? 0) > 0);

    await failingIngest(fileId, fakeStorage({ throws: new Error("transient") }));

    const after = await observer.documentIngestion.findFirstOrThrow({ where: { fileAssetId: fileId } });
    const rows = await observer.documentChunk.count({ where: { fileAssetId: fileId } });

    assert.equal(after.status, "failed");
    assert.equal(
      after.chunkCount,
      rows,
      "the recorded chunk count disagrees with the chunks actually stored",
    );
    assert.ok(rows > 0, "a failed reprocess destroyed the previous good chunk set");
  });
});

describe("documents we do not read", () => {
  test("a non-PDF gets no ingestion row at all", async () => {
    const fileId = await makeFile("photo.png", "image/png");
    const outcome = await inContext(() =>
      ingestFileAsset({ fileAssetId: fileId, workspaceId: A.workspaceId }, { storage: fakeStorage({ bytes: goodPdf() }) }),
    );

    assert.deepEqual(outcome, { ingested: false, reason: "unsupported_type" });
    assert.equal(await observer.documentIngestion.count({ where: { fileAssetId: fileId } }), 0);
  });

  test("a scanned document is no_text, with no chunks and no error", async () => {
    const fileId = await makeFile();
    const scanned = new Uint8Array(buildPdf(KNOWN_GOOD_PAGES, { imageOnlyPages: [1, 2, 3] }));

    const outcome = await inContext(() =>
      ingestFileAsset({ fileAssetId: fileId, workspaceId: A.workspaceId }, { storage: fakeStorage({ bytes: scanned }) }),
    );

    assert.equal(outcome.ingested && outcome.status, "no_text");
    const row = await observer.documentIngestion.findFirstOrThrow({ where: { fileAssetId: fileId } });
    assert.equal(row.status, "no_text");
    assert.equal(row.errorCode, null, "an unreadable scan was reported as an error");
    assert.equal(row.chunkCount, 0);
    assert.ok((row.pageCount ?? 0) > 0, "the page count was lost");
  });

  test("a file that no longer exists is reported, not invented", async () => {
    const outcome = await inContext(() =>
      ingestFileAsset(
        { fileAssetId: "file_does_not_exist", workspaceId: A.workspaceId },
        { storage: fakeStorage({ bytes: goodPdf() }) },
      ),
    );
    assert.deepEqual(outcome, { ingested: false, reason: "missing_file" });
  });
});

describe("through the real job runner", () => {
  test("a failure recorded by the handler survives the job's transaction", async () => {
    /**
     * The claim the failure tests above rest on, proven rather than reasoned
     * about: that `runOneInContext` catches the handler's error, so the
     * transaction commits and the ingestion record is still there afterwards.
     *
     * This drives the whole path — emitEvent, claim, handler, bookkeeping —
     * with no storage configured, so `getStorage()` is the unconfigured driver
     * and `readObject` refuses. That is a real failure through the real runner.
     */
    const { emitEvent } = await import("../../src/lib/events");
    const { runJobs } = await import("../../src/lib/jobs");
    const { registerJobHandlers } = await import("../../src/lib/jobs/handlers");
    registerJobHandlers();

    const fileId = await makeFile();
    await emitEvent({
      workspaceId: A.workspaceId,
      name: "file.uploaded",
      entityType: "fileAsset",
      entityId: fileId,
      actorId: A.ownerId,
      payload: { projectId: A.projectId },
    });

    const result = await runJobs(50);
    assert.ok(result.processed + result.failed + result.dead > 0, "no job was claimed at all");

    const row = await observer.documentIngestion.findFirst({ where: { fileAssetId: fileId } });
    assert.ok(
      row,
      "the ingestion record did not survive the job's transaction — a failed " +
        "ingestion would leave no trace at all",
    );
    assert.equal(row.status, "failed");
    assert.equal(row.errorCode, "storage_unavailable");
    assert.equal(await observer.documentChunk.count({ where: { fileAssetId: fileId } }), 0);
  });

  test("a gated workspace's event completes without writing anything", async () => {
    // What every workspace sees while this phase is deployed dark: the event is
    // delivered, the handler runs, and nothing happens.
    await setGate("documentAi", false);

    const { emitEvent } = await import("../../src/lib/events");
    const { runJobs } = await import("../../src/lib/jobs");
    const { registerJobHandlers } = await import("../../src/lib/jobs/handlers");
    registerJobHandlers();

    const fileId = await makeFile();
    await emitEvent({
      workspaceId: A.workspaceId,
      name: "file.uploaded",
      entityType: "fileAsset",
      entityId: fileId,
      actorId: A.ownerId,
      payload: {},
    });

    const result = await runJobs(50);
    assert.equal(result.dead, 0, "a gated ingestion dead-lettered");
    assert.equal(
      await observer.documentIngestion.count({ where: { fileAssetId: fileId } }),
      0,
      "a gated workspace got an ingestion row",
    );
  });
});

describe("turning documentAi off after a document was ingested", () => {
  test("keeps the extracted data but closes access", async () => {
    // The decision recorded in the Phase 3C plan: disabling the feature stops
    // new processing and closes the Document Intelligence surfaces, and does
    // **not** destroy work already done. Deletion is an explicit lifecycle
    // operation — deleting the document — not a side effect of a toggle.
    const fileId = await makeFile();
    await inContext(() =>
      ingestFileAsset({ fileAssetId: fileId, workspaceId: A.workspaceId }, { storage: fakeStorage({ bytes: goodPdf() }) }),
    );
    const chunksBefore = await observer.documentChunk.count({ where: { fileAssetId: fileId } });
    assert.ok(chunksBefore > 0);

    await setGate("documentAi", false);

    // Access is closed.
    await assert.rejects(
      () => inContext(() => getDocumentIntelligence(fileId, A.workspaceId)),
      /not enabled for this workspace/,
      "intelligence stayed readable after documentAi was turned off",
    );
    await assert.rejects(
      () => inContext(() => getDocumentChunks(fileId, A.workspaceId)),
      /not enabled for this workspace/,
    );

    // The data is untouched.
    assert.equal(
      await observer.documentChunk.count({ where: { fileAssetId: fileId } }),
      chunksBefore,
      "turning a flag off destroyed extracted text",
    );

    // And no new processing happens.
    const outcome = await inContext(() =>
      ingestFileAsset({ fileAssetId: fileId, workspaceId: A.workspaceId }, { storage: fakeStorage({ bytes: goodPdf() }) }),
    );
    assert.deepEqual(outcome, { ingested: false, reason: "gated" });
  });
});
