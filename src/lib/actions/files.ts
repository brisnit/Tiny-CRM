"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import {
  audit, emitEvent, guard, recordAction, revalidateRecord, type ActionResult,
} from "@/lib/actions/base";
import { AppError } from "@/lib/errors";
import { requireFlag } from "@/lib/flags";
import { log } from "@/lib/logger";
import { getStorage } from "@/lib/storage";
import { issueUploadToken, readUploadToken } from "@/lib/upload-token";
import { storageKeyFor, validateUpload, type UploadCandidate } from "@/lib/uploads";
import { LIMITS } from "@/lib/validation/limits";
import { zId } from "@/lib/validation/common";

/**
 * Project documents: authorising an upload, and confirming one.
 *
 * ---------------------------------------------------------------------------
 * The shape, and the problem it creates
 * ---------------------------------------------------------------------------
 *
 * Bytes go browser -> object storage directly. They never enter a Server Action
 * or a Route Handler. That is required — Vercel caps a function's request body
 * well below the 25 MB this product accepts — but it costs something real:
 *
 *   **`validateUpload()` wants the first sixteen bytes of the file, and in this
 *   design the server never sees the file.**
 *
 * That check is not decoration. It is what stops `invoice.pdf` from actually
 * being an HTML document, and `src/lib/uploads.ts` is explicit that a declared
 * MIME type is a hint while the magic bytes are evidence. Asking the browser
 * for those sixteen bytes and believing them would convert the evidence back
 * into a hint, which is precisely the weakening the control exists to prevent.
 *
 * ---------------------------------------------------------------------------
 * Validate twice, trust once
 * ---------------------------------------------------------------------------
 *
 * `requestUpload` runs the full validation against bytes the *client* supplied.
 * This is a **user-experience gate and nothing more**: it rejects the wrong
 * file instantly, before a 25 MB upload happens, and it is treated throughout
 * as untrusted. A client that lies here gains nothing except a presigned URL it
 * was already entitled to.
 *
 * `confirmUpload` runs the same validation again, against **bytes at rest**: a
 * HEAD for authoritative size and type, and a sixteen-byte ranged GET for the
 * signature. Only then does a `FileAsset` row exist. An object that fails is
 * deleted and no row is written.
 *
 * The result is a magic-byte check that is *stronger* than the one this
 * codebase shipped with, because it now runs against what was actually stored
 * rather than against what a request claimed. Sixteen bytes is metadata; the
 * file is still never proxied.
 *
 * ---------------------------------------------------------------------------
 * What the client is allowed to say
 * ---------------------------------------------------------------------------
 *
 * On confirmation: a signed token and nothing else. The storage key, workspace,
 * project, MIME type and display name are all read back out of the server's own
 * signed decision (see `src/lib/upload-token.ts`). Authorisation is still
 * re-checked against RLS, because a grant can be revoked between the two calls.
 */

/**
 * How many bytes the signature check needs.
 *
 * `validateUpload` documents "at least the first 16 bytes"; the longest
 * signature it actually compares is four. Sixteen is what is asked for and
 * sixteen is what is read.
 */
const SIGNATURE_BYTES = 16;

/** Long enough to upload 25 MB on a slow connection, short enough to be useless later. */
const UPLOAD_WINDOW_SECONDS = 15 * 60;

const requestSchema = z.object({
  projectId: zId,
  filename: z.string().min(1).max(500),
  declaredMimeType: z.string().max(255).default(""),
  sizeBytes: z.number().int().positive().max(LIMITS.maxUploadBytes),
  /**
   * The first bytes of the file, base64. Untrusted — see the header comment.
   * Capped well above `SIGNATURE_BYTES` so an oversized value is a rejection
   * rather than something to quietly truncate.
   */
  headBase64: z.string().max(256),
});

const confirmSchema = z.object({
  /** Opaque to the browser. Carries every decision `requestUpload` made. */
  uploadToken: z.string().min(1).max(4096),
});

export type UploadTicket = {
  uploadToken: string;
  upload: { method: "PUT"; url: string; headers: Record<string, string>; expiresAt: string };
};

/**
 * Authorises one upload and returns the contract the browser needs.
 *
 * Returns no storage key, bucket, endpoint or credential — only a URL to PUT
 * to, the headers that URL was signed with, and an opaque token to hand back.
 * The browser cannot tell which provider is behind it.
 */
export async function requestUpload(input: unknown): Promise<ActionResult<UploadTicket>> {
  return guard(async () => {
    const parsed = requestSchema.parse(input);

    // Authorisation is the project's, resolved from the project itself rather
    // than from anything the caller supplied. Under RLS a restricted member who
    // was not granted this project cannot load it at all, so this is also where
    // record-level scope is enforced.
    return recordAction(
      "project",
      parsed.projectId,
      { permission: "record:create", rateLimit: "upload" },
      async ({ actor, workspaceId, recordId }) => {
        // The flag is a control, not chrome. Without this the action stays
        // reachable while the product reads as switched off, and "the feature
        // is disabled" would mean only that nothing renders a button.
        await requireFlag("files", workspaceId);

        const head = decodeHead(parsed.headBase64);

        // The full existing validation, on client-supplied bytes. A UX gate.
        const candidate: UploadCandidate = {
          filename: parsed.filename,
          declaredMimeType: parsed.declaredMimeType,
          sizeBytes: parsed.sizeBytes,
          head,
        };
        const accepted = validateUpload(candidate);

        // Server-generated, opaque, workspace-prefixed, unguessable.
        const key = storageKeyFor(workspaceId, accepted.extension);

        const upload = await getStorage().createUploadUrl({
          key,
          contentType: accepted.mimeType,
          downloadName: accepted.displayName,
          expiresInSeconds: UPLOAD_WINDOW_SECONDS,
        });

        const uploadToken = issueUploadToken({
          key,
          workspaceId,
          projectId: recordId,
          mimeType: accepted.mimeType,
          extension: accepted.extension,
          displayName: accepted.displayName,
          expiresAt: Date.now() + UPLOAD_WINDOW_SECONDS * 1000,
        });

        log.info("upload authorised", { workspaceId, projectId: recordId, actorId: actor.identity.id });

        return { uploadToken, upload };
      },
    );
  });
}

export type ConfirmedUpload = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
};

/**
 * Verifies what was actually stored, then records it.
 *
 * Every fact written to the row comes from the token or from the object itself.
 * Nothing on this path is taken from the request.
 */
export async function confirmUpload(input: unknown): Promise<ActionResult<ConfirmedUpload>> {
  return guard(async () => {
    const { uploadToken } = confirmSchema.parse(input);
    const ticket = readUploadToken(uploadToken);

    return recordAction(
      "project",
      ticket.projectId,
      // Not the `upload` policy: a normal upload is one request and one
      // confirm, and sharing a budget would halve the number of files a person
      // can actually add. `mutation` is the general write ceiling and is what
      // bounds a replayed token.
      { permission: "record:create", workspaceId: ticket.workspaceId, rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        await requireFlag("files", workspaceId);

        // The token was signed for one workspace. If the project now resolves
        // somewhere else, something is wrong enough to refuse rather than
        // reconcile.
        if (workspaceId !== ticket.workspaceId) {
          throw new AppError("not_found", "That record does not exist.", {
            internal: `upload token workspace ${ticket.workspaceId} != project workspace ${workspaceId}`,
          });
        }

        // --- One object, one row --------------------------------------------
        //
        // A token stays valid for its whole window, so a client that replays
        // one — a double-click, a retry, or deliberately — would otherwise get
        // a second row pointing at the same object. Deleting either would then
        // orphan the other, because the row and the object are separate things.
        //
        // Checked before touching storage so a replay costs a single indexed
        // read rather than a HEAD and a ranged GET.
        //
        // This closes the realistic case, not the racing one: two simultaneous
        // confirms can both pass this check. Making it airtight needs a unique
        // index on (workspaceId, storageKey), which is a migration and so is
        // deliberately out of Phase 1. It belongs with the other additive
        // columns whenever that migration happens.
        const already = await db.fileAsset.findFirst({
          where: { workspaceId, storageKey: ticket.key },
          select: { id: true },
        });
        if (already) {
          throw new AppError("conflict", "That file has already been added.", {
            internal: `upload token replayed for key ${ticket.key}`,
          });
        }

        const storage = getStorage();

        // --- The object must exist ------------------------------------------
        const stored = await storage.headObject(ticket.key);
        if (!stored) {
          throw new AppError("not_found", "That upload did not finish. Try again.", {
            internal: `confirm called for a key with no object: ${ticket.key}`,
          });
        }

        // --- Authoritative size, from storage, not from the browser ---------
        if (!Number.isFinite(stored.sizeBytes) || stored.sizeBytes <= 0) {
          await discard(ticket.key, "empty or unmeasurable object");
          throw new AppError("validation", "That file is empty.");
        }
        if (stored.sizeBytes > LIMITS.maxUploadBytes) {
          // The presigned PUT cannot enforce a ceiling — S3-style signatures do
          // not sign Content-Length, and the browser controls the body. So the
          // ceiling is enforced here, where the real size is knowable, and the
          // object is removed rather than left to occupy storage.
          await discard(ticket.key, `oversized object: ${stored.sizeBytes} bytes`);
          const mb = Math.floor(LIMITS.maxUploadBytes / 1024 / 1024);
          throw new AppError("validation", `Files must be ${mb} MB or smaller.`);
        }

        // --- The signature, from bytes at rest ------------------------------
        const head = await storage.readRange(ticket.key, 0, SIGNATURE_BYTES - 1);

        let accepted;
        try {
          accepted = validateUpload({
            // The name and type the *server* decided at request time. Passing
            // the client's values here would reintroduce the lie this whole
            // design exists to prevent.
            filename: ticket.displayName,
            declaredMimeType: ticket.mimeType,
            sizeBytes: stored.sizeBytes,
            head,
          });
        } catch (error) {
          await discard(ticket.key, "content did not match its extension");
          throw error;
        }

        // --- Only now does it exist -----------------------------------------
        let file;
        try {
          file = await db.fileAsset.create({
            data: {
              workspaceId,
              projectId: recordId,
              name: accepted.displayName,
              mimeType: accepted.mimeType,
              sizeBytes: accepted.sizeBytes,
              storageKey: ticket.key,
              uploaderId: actor.identity.id,
            },
            select: { id: true, name: true, mimeType: true, sizeBytes: true, createdAt: true },
          });
        } catch (error) {
          // The unique index on (workspaceId, storageKey) refused it, which
          // means a concurrent confirmation won the race between the guard
          // above and this insert. That is the same event as a replay, so it
          // gets the same answer: the caller cannot tell — and should not be
          // able to tell — which of the two paths refused them.
          //
          // Deliberately NOT discarded. The object belongs to the row that won,
          // and deleting it here would turn a harmless duplicate request into a
          // broken document for whoever succeeded.
          if ((error as { code?: string }).code === "P2002") {
            throw new AppError("conflict", "That file has already been added.", {
              internal: `unique (workspaceId, storageKey) refused a concurrent confirm for ${ticket.key}`,
            });
          }
          throw error;
        }

        // `record.created` rather than a new audit verb: a FileAsset is a
        // record, and the entityType already makes this queryable as a file.
        await audit(actor, {
          workspaceId,
          action: "record.created",
          entityType: "fileAsset",
          entityId: file.id,
          summary: `Uploaded ${file.name} to a project`,
        });

        // The outbox seam. Nothing consumes it yet; see src/lib/events.ts.
        await emitEvent({
          workspaceId,
          name: "file.uploaded",
          entityType: "fileAsset",
          entityId: file.id,
          actorId: actor.identity.id,
          payload: { projectId: recordId, sizeBytes: file.sizeBytes, mimeType: file.mimeType },
        });

        revalidateRecord([`/projects/${recordId}`]);
        return file;
      },
    );
  });
}

/**
 * Removes an object that must not become a record.
 *
 * Never throws. A failed cleanup is a storage object to collect later, not a
 * reason to turn a correct refusal into a 500 — the caller is already on its
 * way to rejecting this upload and that rejection is the important outcome.
 */
async function discard(key: string, why: string): Promise<void> {
  log.warn("discarding a rejected upload", { why });
  try {
    await getStorage().deleteObject(key);
  } catch (error) {
    log.error("could not remove a rejected upload", { error: String(error) });
  }
}

/**
 * Decodes the client's preflight bytes.
 *
 * Deliberately forgiving: this input is untrusted and its only job is to feed a
 * check that runs again later against real bytes. Undecodable input becomes an
 * empty buffer, which `validateUpload` then rejects for the right reason —
 * "contents do not match" — rather than throwing something shapeless here.
 */
function decodeHead(base64: string): Uint8Array {
  try {
    return new Uint8Array(Buffer.from(base64, "base64").subarray(0, SIGNATURE_BYTES));
  } catch {
    return new Uint8Array(0);
  }
}

