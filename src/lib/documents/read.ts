import "server-only";

import type { ReadScope } from "@/lib/auth/access";
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
 * ---------------------------------------------------------------------------
 * Why these take a ReadScope rather than a workspace id
 * ---------------------------------------------------------------------------
 *
 * The first version took `(fileAssetId, workspaceId)`. That is the wrong shape:
 * the workspace was an *argument*, so the signature invited a caller to supply
 * one, and "the caller passes one it has already earned" was a convention
 * rather than a constraint. Nothing exploited it — the module was unreferenced
 * and both row-level security and the gate make an unowned workspace fail
 * closed — but a boundary that depends on every future caller reading a comment
 * is not a boundary.
 *
 * A `ReadScope` is produced by `resolveReadScope` from the actor's own
 * memberships and carries the restricted-project scope with it. It cannot be
 * manufactured from request input, which makes the honest version of the rule
 * expressible in the type. `searchEverything` in src/lib/data/search.ts is the
 * same shape for the same reason.
 *
 * Widening is still impossible below this: the workspace used is the
 * intersection of the scope with the file's own workspace, and row-level
 * security is the backstop underneath that.
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
  read: ReadScope,
  fileAssetId: string,
): Promise<DocumentIntelligenceSummary | null> {
  const workspaceId = await workspaceOf(read, fileAssetId);
  if (!workspaceId) return null;
  await requireDocumentIntelligence(workspaceId);

  const row = await db.documentIngestion.findFirst({
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
  read: ReadScope,
  fileAssetId: string,
  options: { take?: number } = {},
): Promise<RetrievedChunk[]> {
  const workspaceId = await workspaceOf(read, fileAssetId);
  if (!workspaceId) return [];
  await requireDocumentIntelligence(workspaceId);

  return db.documentChunk.findMany({
    where: { fileAssetId, workspaceId },
    orderBy: { ordinal: "asc" },
    take: Math.min(options.take ?? 200, 500),
    select: { ordinal: true, text: true, pageStart: true, pageEnd: true },
  });
}

/**
 * The file's own workspace, if this scope reaches it.
 *
 * Resolved from the row rather than taken from the caller, and constrained to
 * the scope's workspaces, so a file outside the scope is indistinguishable from
 * one that does not exist. Row-level security narrows it again underneath —
 * a restricted member reaching for an ungranted project's file gets nothing
 * here even though the workspace matches.
 */
async function workspaceOf(read: ReadScope, fileAssetId: string): Promise<string | null> {
  if (read.workspaceIds.length === 0) return null;
  const file = await db.fileAsset.findFirst({
    where: { id: fileAssetId, workspaceId: { in: read.workspaceIds } },
    select: { workspaceId: true },
  });
  return file?.workspaceId ?? null;
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
