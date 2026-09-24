import "server-only";

import { db } from "@/lib/db";
import { requireDocumentIntelligence } from "@/lib/documents/gate";
import type { DocumentErrorCode, DocumentIngestionStatus } from "@/lib/enums";

/**
 * Reading what was extracted.
 *
 * The minimum surface the foundation needs: enough for a future Ask Tiny to
 * build on, and enough for the gate behaviour to be testable. No retrieval
 * ranking, no scoring, no UI.
 *
 * Every function here goes through `requireDocumentIntelligence`, which means
 * turning `documentAi` off closes access as well as stopping new processing.
 * It deliberately does **not** delete anything: extracted text that took real
 * work to produce is not thrown away because a flag was toggled, and a flag is
 * not a lifecycle operation. Deleting the document deletes the text, and that
 * is the one path that does.
 *
 * Nothing here accepts a workspace id from a request. The caller passes one it
 * has already earned, inside a tenant context, and row-level security is the
 * backstop underneath that.
 */

export type DocumentIntelligenceSummary = {
  status: DocumentIngestionStatus;
  pageCount: number | null;
  charCount: number | null;
  chunkCount: number | null;
  errorCode: DocumentErrorCode | null;
  warnings: string[];
  finishedAt: Date | null;
};

/** What a UI would need to say "ready", "still reading", or "couldn't read this". */
export async function getDocumentIntelligence(
  fileAssetId: string,
  workspaceId: string,
): Promise<DocumentIntelligenceSummary | null> {
  await requireDocumentIntelligence(workspaceId);

  const row = await db.documentIngestion.findFirst({
    // Both columns, though `fileAssetId` is unique: the workspace is what the
    // caller earned, and naming it keeps this query honest even if someone
    // later passes an id from somewhere less trustworthy.
    where: { fileAssetId, workspaceId },
    select: {
      status: true,
      pageCount: true,
      charCount: true,
      chunkCount: true,
      errorCode: true,
      warnings: true,
      finishedAt: true,
    },
  });
  if (!row) return null;

  return {
    status: row.status as DocumentIngestionStatus,
    pageCount: row.pageCount,
    charCount: row.charCount,
    chunkCount: row.chunkCount,
    errorCode: row.errorCode as DocumentErrorCode | null,
    warnings: parseWarnings(row.warnings),
    finishedAt: row.finishedAt,
  };
}

export type RetrievedChunk = {
  ordinal: number;
  text: string;
  pageStart: number;
  pageEnd: number;
};

/**
 * One document's chunks, in order.
 *
 * `take` is a hard ceiling rather than a page size: this is the seam a future
 * retrieval step narrows, and it should not be possible to ask for a whole
 * corpus by accident.
 */
export async function getDocumentChunks(
  fileAssetId: string,
  workspaceId: string,
  options: { take?: number } = {},
): Promise<RetrievedChunk[]> {
  await requireDocumentIntelligence(workspaceId);

  return db.documentChunk.findMany({
    where: { fileAssetId, workspaceId },
    orderBy: { ordinal: "asc" },
    take: Math.min(options.take ?? 200, 500),
    select: { ordinal: true, text: true, pageStart: true, pageEnd: true },
  });
}

function parseWarnings(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === "string") : [];
  } catch {
    // A warning list we cannot parse is not worth failing a read over.
    return [];
  }
}
