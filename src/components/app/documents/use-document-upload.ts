"use client";

import * as React from "react";

import { confirmUpload, requestUpload } from "@/lib/actions/files";
import { LIMITS } from "@/lib/validation/limits";

/**
 * Uploading documents from the browser.
 *
 * ---------------------------------------------------------------------------
 * Why XMLHttpRequest, in a codebase that otherwise uses fetch
 * ---------------------------------------------------------------------------
 *
 * `fetch` cannot report upload progress. It resolves when the response arrives,
 * and exposes nothing about how much of the request body has gone out; the
 * streaming request bodies that would allow it are not usable here. XHR has
 * `upload.onprogress` and has had it for fifteen years, so a feature whose whole
 * point is showing a 25 MB file moving needs XHR.
 *
 * It is confined to this file. Nothing else in the app uses it, and nothing
 * outside this hook needs to know it exists.
 *
 * ---------------------------------------------------------------------------
 * What this hook knows about storage: nothing
 * ---------------------------------------------------------------------------
 *
 * `requestUpload` hands back a method, a URL and a set of headers. This sends
 * the bytes to exactly that, and could not name the provider if it wanted to.
 * Swapping R2 for something else changes a server module and not one line here.
 *
 * ---------------------------------------------------------------------------
 * Three steps, and which of them is trusted
 * ---------------------------------------------------------------------------
 *
 *   1. read the first sixteen bytes and ask the server to authorise an upload
 *   2. PUT the file straight to storage
 *   3. tell the server it landed, and let it verify that for itself
 *
 * The bytes in step 1 are a courtesy: they let the server reject an obviously
 * wrong file before 25 MB moves. The server re-reads them from storage in step
 * 3 and believes only that. Nothing here is a security control — the checks
 * below exist to save a doomed upload, not to decide anything.
 */

export type UploadStatus = "queued" | "preparing" | "uploading" | "confirming" | "done" | "failed";

export type UploadItem = {
  /** Client-side only; never reaches the server. */
  id: string;
  name: string;
  sizeBytes: number;
  status: UploadStatus;
  /** 0-100, meaningful while `status` is "uploading". */
  percent: number;
  error?: string;
};

/** How many files move at once. Enough to use the connection, few enough to read. */
const CONCURRENCY = 2;

const SIGNATURE_BYTES = 16;

export function useDocumentUpload(options: {
  projectId: string;
  /** Extensions the server will accept, passed in because the allowlist is server-only. */
  allowedExtensions: readonly string[];
  /** Called once a batch has settled, successes or not. */
  onSettled: (summary: { succeeded: number; failed: number }) => void;
}) {
  const { projectId, allowedExtensions, onSettled } = options;

  const [items, setItems] = React.useState<UploadItem[]>([]);
  // The File objects themselves live outside React state: they are large, never
  // rendered, and must survive a retry.
  const files = React.useRef(new Map<string, File>());

  // Kept in a ref so the upload loop always calls the latest one without being
  // rebuilt (and restarted) every render.
  const settled = React.useRef(onSettled);
  settled.current = onSettled;

  const patch = React.useCallback((id: string, next: Partial<UploadItem>) => {
    setItems((previous) => previous.map((item) => (item.id === id ? { ...item, ...next } : item)));
  }, []);

  const runOne = React.useCallback(
    async (id: string): Promise<boolean> => {
      const file = files.current.get(id);
      if (!file) return false;

      try {
        patch(id, { status: "preparing", percent: 0, error: undefined });

        const head = new Uint8Array(await file.slice(0, SIGNATURE_BYTES).arrayBuffer());

        const ticket = await requestUpload({
          projectId,
          filename: file.name,
          declaredMimeType: file.type,
          sizeBytes: file.size,
          headBase64: toBase64(head),
        });
        if (!ticket.ok) {
          patch(id, { status: "failed", error: ticket.error });
          return false;
        }

        patch(id, { status: "uploading", percent: 0 });
        await put(ticket.data.upload, file, (percent) => patch(id, { percent }));

        patch(id, { status: "confirming", percent: 100 });
        const confirmed = await confirmUpload({ uploadToken: ticket.data.uploadToken });
        if (!confirmed.ok) {
          patch(id, { status: "failed", error: confirmed.error });
          return false;
        }

        patch(id, { status: "done", percent: 100 });
        // The row is now on the server and the refreshed list will show it, so
        // the queue entry has nothing left to say.
        files.current.delete(id);
        return true;
      } catch (error) {
        patch(id, {
          status: "failed",
          error: error instanceof Error ? error.message : "That upload did not finish.",
        });
        return false;
      }
    },
    [patch, projectId],
  );

  /** Runs ids through a small pool and reports how the batch went. */
  const drain = React.useCallback(
    async (ids: string[]) => {
      const queue = [...ids];
      let succeeded = 0;
      let failed = 0;

      const worker = async () => {
        for (;;) {
          const id = queue.shift();
          if (!id) return;
          if (await runOne(id)) succeeded += 1;
          else failed += 1;
        }
      };

      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
      settled.current({ succeeded, failed });
    },
    [runOne],
  );

  const enqueue = React.useCallback(
    async (chosen: File[]) => {
      const accepted: UploadItem[] = [];

      for (const file of chosen) {
        const id = crypto.randomUUID();
        const rejection = precheck(file, allowedExtensions);

        if (rejection) {
          // Still shown as a row. A file that silently vanishes on being chosen
          // reads as a broken control rather than a rejected file.
          accepted.push({
            id, name: file.name, sizeBytes: file.size,
            status: "failed", percent: 0, error: rejection,
          });
          continue;
        }

        files.current.set(id, file);
        accepted.push({ id, name: file.name, sizeBytes: file.size, status: "queued", percent: 0 });
      }

      setItems((previous) => [...previous, ...accepted]);

      const runnable = accepted.filter((item) => item.status === "queued").map((item) => item.id);
      if (runnable.length === 0) {
        settled.current({ succeeded: 0, failed: accepted.length });
        return;
      }
      await drain(runnable);
    },
    [allowedExtensions, drain],
  );

  /**
   * Retries one failed upload.
   *
   * A fresh attempt from step 1: a new authorisation, a new storage key, a new
   * token. Nothing from the failed attempt is reused, so a retry cannot land on
   * top of another file, and it cannot duplicate a file that already succeeded —
   * a successful item is no longer retryable and its File has been dropped.
   */
  const retry = React.useCallback(
    async (id: string) => {
      if (!files.current.has(id)) return;
      await drain([id]);
    },
    [drain],
  );

  /** Removes a settled row from the queue. */
  const dismiss = React.useCallback((id: string) => {
    files.current.delete(id);
    setItems((previous) => previous.filter((item) => item.id !== id));
  }, []);

  /** Clears everything that finished, leaving failures for the person to see. */
  const clearCompleted = React.useCallback(() => {
    setItems((previous) => previous.filter((item) => item.status !== "done"));
  }, []);

  return { items, enqueue, retry, dismiss, clearCompleted };
}

/**
 * The cheap checks, done before anything moves.
 *
 * Not a control — `validateUpload` on the server decides, twice, and one of
 * those times is against the bytes actually stored. This only spares someone a
 * pointless upload and gives them a reason immediately.
 */
function precheck(file: File, allowed: readonly string[]): string | null {
  if (file.size === 0) return "That file is empty.";
  if (file.size > LIMITS.maxUploadBytes) {
    return `Files must be ${Math.floor(LIMITS.maxUploadBytes / 1024 / 1024)} MB or smaller.`;
  }

  const dot = file.name.lastIndexOf(".");
  const extension = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (!extension) return "That file has no extension, so its type cannot be confirmed.";
  if (!allowed.includes(extension)) return `.${extension} files are not accepted.`;

  return null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The PUT, with progress.
 *
 * Headers come from the server's signed contract and are sent verbatim: they
 * are part of the signature, so altering one here would not sneak anything past
 * storage, it would simply fail.
 */
function put(
  contract: { method: string; url: string; headers: Record<string, string> },
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(contract.method, contract.url, true);

    for (const [name, value] of Object.entries(contract.headers)) {
      request.setRequestHeader(name, value);
    }

    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      }
    };

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      // The storage provider's body can name buckets and keys, so it is not
      // surfaced. The status is enough to tell a person to try again.
      else reject(new Error(`Storage refused the upload (${request.status}).`));
    };
    request.onerror = () => reject(new Error("The upload could not reach storage."));
    request.ontimeout = () => reject(new Error("The upload timed out."));

    request.send(file);
  });
}
