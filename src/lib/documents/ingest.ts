import "server-only";

import { db } from "@/lib/db";
import { log } from "@/lib/logger";
import { LIMITS } from "@/lib/validation/limits";
import { getStorage, StorageObjectMissing, StorageObjectTooLarge, type StorageDriver } from "@/lib/storage";
import { documentIntelligenceEnabled } from "@/lib/documents/gate";
import { chunkDocument } from "@/lib/documents/chunk";
import { classify } from "@/lib/documents/classify";
import { EXTRACTOR_VERSION, PdfExtractionError, extractPdf } from "@/lib/documents/extract";
import type { DocumentErrorCode, DocumentIngestionStatus } from "@/lib/enums";

/**
 * Reading one uploaded document.
 *
 * Runs in a background job, never in the request that uploaded the file: an
 * upload is finished when the bytes are stored and the row exists, and making a
 * person wait for a 36-page RFP to be parsed would be charging them for a
 * feature they did not ask for at that moment.
 *
 * ---------------------------------------------------------------------------
 * The order of operations, and why it is that order
 * ---------------------------------------------------------------------------
 *
 *   gates -> resolve the file -> mark processing -> read bytes -> extract ->
 *   classify -> chunk -> persist everything in one transaction
 *
 * **Gates first**, because the cheapest way to not leak a document is to never
 * read it. With `documentAi` off this function does nothing and writes nothing
 * — which is what lets this whole phase deploy dark.
 *
 * **The file is resolved from the database, not from the event.** The event
 * payload carries a `projectId` and a size; none of it is trusted. The row is
 * read by id within the job's own tenant context, so row-level security decides
 * whether this job may see it, exactly as it would for a request.
 *
 * **Persistence is one transaction.** Chunks and the status that describes them
 * commit together. A failure part-way leaves the previous state, never half a
 * chunk set with a `ready` status over it.
 *
 * ---------------------------------------------------------------------------
 * Idempotency
 * ---------------------------------------------------------------------------
 *
 * Duplicate delivery of `file.uploaded` is expected — the outbox is at-least-
 * once, a claim can expire mid-run, and a dead job can be replayed by hand.
 * Two mechanisms make that harmless:
 *
 *   * one ingestion row per file, enforced by a unique constraint, reached
 *     through an upsert rather than a read-then-insert;
 *   * chunks for a run are deleted and rewritten inside the same transaction,
 *     with `@@unique([ingestionId, ordinal])` as the backstop.
 *
 * Because chunking is deterministic, a redelivery rewrites byte-identical rows.
 */

/** Never buffer more than one upload's worth of bytes to read a document. */
const MAX_DOCUMENT_BYTES = LIMITS.maxUploadBytes;

/** The only thing this phase can read. Anything else is simply not ingested. */
const SUPPORTED_MIME_TYPES = new Set(["application/pdf"]);

/**
 * Failures that retrying cannot fix.
 *
 * These become `unsupported` — a terminal statement about the document — and
 * the job returns rather than throwing, so the runner does not spend five
 * attempts on a password-protected file and then raise a dead-letter alert that
 * reads like an outage. Retrying cannot make a damaged PDF parse, and the
 * person who uploaded it needs to be told.
 *
 * A timeout is deliberately **not** here. It is reported as `internal`, because
 * a slow run is our problem and the next attempt may well succeed — which is
 * why extract.ts gives timeouts their own code instead of calling them
 * `unreadable`. The two failures look alike and need opposite handling.
 */
const TERMINAL_ERROR_CODES: readonly DocumentErrorCode[] = [
  "encrypted",
  "unsupported_type",
  "too_large",
  "unreadable",
];

export type IngestOutcome =
  | { ingested: false; reason: "gated" | "unsupported_type" | "missing_file" }
  | { ingested: true; status: DocumentIngestionStatus; chunks: number; pages: number };

/**
 * Reads one document and records what came out.
 *
 * Must be called inside a tenant context for the file's workspace — the gate
 * asserts it rather than opening one, because a gate that grants itself
 * authority is not a gate.
 */
export async function ingestFileAsset(
  input: { fileAssetId: string; workspaceId: string },
  /**
   * The storage driver, injectable.
   *
   * Production passes nothing and gets the configured one. The suites pass a
   * driver that returns bytes from memory, so the gate, idempotency, failure
   * and classification paths are exercised on every run rather than only on a
   * machine with MinIO installed — those behaviours have nothing to do with
   * S3, and making them depend on it would mean they usually did not run.
   * `tests/integration/storage.test.ts` covers the real driver against a real
   * endpoint, which is where that coverage belongs.
   */
  options: { storage?: StorageDriver } = {},
): Promise<IngestOutcome> {
  const { fileAssetId, workspaceId } = input;
  const storage = options.storage ?? getStorage();

  // 1. Gates. Nothing below this line happens for a workspace that has not
  //    turned all three on.
  if (!(await documentIntelligenceEnabled(workspaceId))) {
    return { ingested: false, reason: "gated" };
  }

  // 2. The authoritative file, from the database, under RLS.
  const file = await db.fileAsset.findFirst({
    where: { id: fileAssetId, workspaceId },
    select: { id: true, workspaceId: true, mimeType: true, sizeBytes: true, storageKey: true },
  });
  if (!file) return { ingested: false, reason: "missing_file" };

  if (!SUPPORTED_MIME_TYPES.has(file.mimeType)) {
    // Deliberately no row. An "unsupported" ingestion record for every image
    // and spreadsheet would be a table of noise describing files nobody asked
    // us to read. Document Intelligence simply does not apply to them.
    return { ingested: false, reason: "unsupported_type" };
  }

  // 3. Claim the work. The upsert is what makes a redelivery safe.
  const started = new Date();
  const ingestion = await db.documentIngestion.upsert({
    where: { fileAssetId: file.id },
    create: {
      fileAssetId: file.id,
      workspaceId: file.workspaceId,
      status: "processing",
      startedAt: started,
      attempts: 1,
      extractorVersion: EXTRACTOR_VERSION,
    },
    update: {
      status: "processing",
      startedAt: started,
      finishedAt: null,
      errorCode: null,
      attempts: { increment: 1 },
      extractorVersion: EXTRACTOR_VERSION,
    },
    select: { id: true, attempts: true },
  });

  const begun = Date.now();
  try {
    // 4. The bytes. Private, server-side, bounded — never a presigned URL.
    const bytes = await storage.readObject(file.storageKey, MAX_DOCUMENT_BYTES);

    // 5-7. Extract, classify, chunk. None of these touch storage or the network.
    const extracted = await extractPdf(bytes);
    const classification = classify(extracted);
    const chunks = classification.status === "no_text" ? [] : chunkDocument(extracted);

    // 8. One transaction: the chunk set and the status that describes it.
    //
    // The **interactive** form, deliberately. Inside a tenant context the `db`
    // proxy rewrites the array form of `$transaction` into `Promise.all`, which
    // does not order its arguments — and this sequence only means anything in
    // order. A `deleteMany` that lands after its `createMany` deletes the
    // chunks it was supposed to replace, and the document ends up `ready` with
    // no text behind it. The callback form is passed the real transaction
    // client, so `await` means what it says.
    await db.$transaction(async (tx) => {
      await tx.documentChunk.deleteMany({ where: { ingestionId: ingestion.id } });

      if (chunks.length > 0) {
        await tx.documentChunk.createMany({
          data: chunks.map((chunk) => ({
            workspaceId: file.workspaceId,
            fileAssetId: file.id,
            ingestionId: ingestion.id,
            ordinal: chunk.ordinal,
            text: chunk.text,
            pageStart: chunk.pageStart,
            pageEnd: chunk.pageEnd,
            charCount: chunk.charCount,
            tokenEstimate: chunk.tokenEstimate,
          })),
        });
      }

      await tx.documentIngestion.update({
        where: { id: ingestion.id },
        data: {
          status: classification.status,
          pageCount: extracted.pageCount,
          charCount: extracted.charCount,
          chunkCount: chunks.length,
          warnings: JSON.stringify(extracted.warnings),
          errorCode: null,
          finishedAt: new Date(),
        },
      });
    });

    // Counts, statuses and timings. Never text — see docs/DATA-CLASSIFICATION.md.
    log.info("document ingested", {
      fileAssetId: file.id,
      status: classification.status,
      pages: extracted.pageCount,
      chunks: chunks.length,
      chars: extracted.charCount,
      warnings: extracted.warnings.length,
      ms: Date.now() - begun,
    });

    return {
      ingested: true,
      status: classification.status,
      chunks: chunks.length,
      pages: extracted.pageCount,
    };
  } catch (error) {
    const code = errorCodeFor(error);
    const terminal = TERMINAL_ERROR_CODES.includes(code);

    await db.documentIngestion.update({
      where: { id: ingestion.id },
      data: {
        status: terminal ? "unsupported" : "failed",
        errorCode: code,
        finishedAt: new Date(),
        // `chunkCount` is deliberately untouched. A failed run does not delete
        // the chunks of the run before it — those came from the same bytes and
        // are still the best thing we have — so writing 0 here would claim an
        // empty chunk set while the rows are still in the table. It stays null
        // on a first attempt, which is what "nothing has ever been extracted"
        // should look like.
      },
    });

    // The message is not logged. A library or provider message can carry a file
    // path, a bucket name or a fragment of the document itself.
    log.warn("document ingestion failed", {
      fileAssetId: file.id,
      errorCode: code,
      terminal,
      attempt: ingestion.attempts,
      ms: Date.now() - begun,
    });

    if (terminal) {
      return { ingested: true, status: "unsupported", chunks: 0, pages: 0 };
    }
    throw error;
  }
}

/** Maps a thrown value onto the stored category. Never reads its message. */
function errorCodeFor(error: unknown): DocumentErrorCode {
  if (error instanceof PdfExtractionError) return error.code;
  if (error instanceof StorageObjectTooLarge) return "too_large";
  if (error instanceof StorageObjectMissing) return "storage_unavailable";
  // An AppError from the storage driver means storage refused or is absent.
  if (error instanceof Error && error.name === "AppError") return "storage_unavailable";
  return "internal";
}
