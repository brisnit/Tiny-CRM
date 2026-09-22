import { NextResponse, type NextRequest } from "next/server";

import { requireRecordAccess, restrictedIdsFor } from "@/lib/auth/access";
import { db } from "@/lib/db";
import { toAppError } from "@/lib/errors";
import { requireFlag } from "@/lib/flags";
import { log, newRequestId, runWithContext } from "@/lib/logger";
import { getStorage } from "@/lib/storage";
import { withTenantContext } from "@/lib/tenant-db";

/**
 * Downloading a document.
 *
 * ---------------------------------------------------------------------------
 * Why this redirects instead of streaming
 * ---------------------------------------------------------------------------
 *
 * The bytes never pass through this function. It authorises the request, mints
 * a presigned URL that lives for a minute, and sends the browser there. Serving
 * the file from here would undo the thing the whole upload path was built
 * around — Vercel caps what a function may carry, and a 25 MB document is past
 * it — and it would meter every download through the application for no benefit.
 *
 * The redirect target is the object store's own origin, which is *better* than
 * serving user content from ours. A file-typing mistake on this origin is stored
 * XSS with a session cookie attached; on a foreign origin it is a download.
 * `src/lib/uploads.ts` says as much, and this is that advice taken.
 *
 * ---------------------------------------------------------------------------
 * Authorisation
 * ---------------------------------------------------------------------------
 *
 * `requireRecordAccess("fileAsset", id)` and nothing else. That resolves the row
 * inside a tenant context built from the caller's own memberships, so row-level
 * security makes the decision: a restricted member reaches a document only when
 * the project it hangs on was granted to them. There is no second authorisation
 * path here, and no workspace id is accepted from the request.
 *
 * The presigned URL that comes back is unguessable and short-lived, but it is a
 * bearer token for that one object while it lasts. That is the same trade every
 * signed-URL download makes; the mitigation is the sixty-second life.
 */

export const dynamic = "force-dynamic";

/** Long enough to follow a redirect, short enough to be useless if it leaks. */
const DOWNLOAD_TTL_SECONDS = 60;

export async function GET(_request: NextRequest, context: RouteContext<"/api/files/[id]/download">) {
  const requestId = newRequestId();

  return runWithContext({ requestId, route: "api.files.download" }, async () => {
    try {
      const { id } = await context.params;

      // Resolves the row, or refuses. Row-level security decides.
      const { workspaceId, actor } = await requireRecordAccess("fileAsset", id, {
        permission: "record:view",
      });

      // Both of these run inside the tenant context, and the flag check must.
      // `FeatureFlag` is itself workspace-scoped and under row-level security,
      // so `isEnabled` outside a context reads no rows, silently falls back to
      // the built-in default — `files: false` — and reports the feature as
      // disabled for everyone. The server actions avoid this by accident,
      // because `recordAction` has already opened a context around them.
      const file = await withTenantContext(
        {
          workspaceIds: [workspaceId],
          userId: actor.identity.id,
          restrictedWorkspaceIds: restrictedIdsFor(actor.memberships, [workspaceId]),
        },
        async () => {
          await requireFlag("files", workspaceId);
          return db.fileAsset.findFirst({
            where: { id, workspaceId },
            select: { name: true, mimeType: true, storageKey: true },
          });
        },
      );

      if (!file) {
        return NextResponse.json({ error: "That file does not exist." }, { status: 404 });
      }

      const url = await getStorage().createDownloadUrl({
        key: file.storageKey,
        contentType: file.mimeType,
        // Carries `Content-Disposition: attachment`. The object already stores
        // that header from upload; asking for it again on the response covers
        // anything stored before that rule existed.
        downloadName: file.name,
        expiresInSeconds: DOWNLOAD_TTL_SECONDS,
      });

      log.info("document download authorised", { workspaceId });

      // 302 rather than 307: this is a GET and always will be, and the signed
      // URL is single-use in practice. `no-store` keeps the short-lived
      // redirect out of any shared cache.
      return NextResponse.redirect(url, {
        status: 302,
        headers: { "cache-control": "private, no-store" },
      });
    } catch (raw) {
      const error = toAppError(raw);
      if (error.category === "internal") {
        log.error("document download failed", {
          error: error.internal instanceof Error ? error.internal.message : String(error.internal),
        });
      }
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
  });
}
