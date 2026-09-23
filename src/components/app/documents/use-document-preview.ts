"use client";

import * as React from "react";

import { requestDocumentPreview } from "@/lib/actions/files";

/**
 * Fetching a document for the viewer.
 *
 * Two steps, and the split matters. The server action authorises and hands back
 * a short-lived signed URL; the browser then fetches the bytes itself. The
 * application never carries the file, exactly as on the upload path.
 *
 * The bytes land in memory and stay there for as long as the viewer is open.
 * Nothing is written to a cache, a service worker or storage, so closing the
 * viewer really does drop the document — and reopening re-authorises, which is
 * what makes a revoked grant take effect immediately.
 *
 * A `fetch` ignores `Content-Disposition`, which is why the viewer can exist
 * without weakening forced download: the header still says `attachment`, and it
 * still governs the download route, because only a *navigation* consults it.
 */

export type PreviewKind = "pdf" | "image" | "unsupported";

export type PreviewState =
  | { status: "loading" }
  | { status: "ready"; kind: "pdf"; data: ArrayBuffer; name: string }
  | { status: "ready"; kind: "image"; objectUrl: string; name: string }
  | { status: "unsupported"; name: string; mimeType: string }
  | { status: "error"; message: string };

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function kindFor(mimeType: string): PreviewKind {
  if (mimeType === "application/pdf") return "pdf";
  if (IMAGE_TYPES.has(mimeType)) return "image";
  return "unsupported";
}

export function useDocumentPreview(fileId: string | null): PreviewState {
  const [state, setState] = React.useState<PreviewState>({ status: "loading" });

  React.useEffect(() => {
    if (!fileId) return;

    let cancelled = false;
    // Held outside state so cleanup can revoke it even if the component
    // unmounted mid-flight. A leaked object URL pins the whole file in memory.
    let objectUrl: string | null = null;

    void (async () => {
      // Inside the load sequence rather than the effect body: the viewer mounts
      // fresh for each document, so the initial state is already "loading", and
      // this only matters if `fileId` changes while mounted.
      setState({ status: "loading" });
      try {
        const authorised = await requestDocumentPreview(fileId);
        if (cancelled) return;
        if (!authorised.ok) {
          setState({ status: "error", message: authorised.error });
          return;
        }

        const { url, mimeType, name } = authorised.data;
        const kind = kindFor(mimeType);
        if (kind === "unsupported") {
          setState({ status: "unsupported", name, mimeType });
          return;
        }

        const response = await fetch(url);
        if (cancelled) return;
        if (!response.ok) {
          // The storage provider's body can name buckets and keys, so only the
          // status reaches the person.
          setState({ status: "error", message: `Could not load this document (${response.status}).` });
          return;
        }

        if (kind === "pdf") {
          const data = await response.arrayBuffer();
          if (cancelled) return;
          setState({ status: "ready", kind: "pdf", data, name });
        } else {
          const blob = await response.blob();
          if (cancelled) return;
          objectUrl = URL.createObjectURL(blob);
          setState({ status: "ready", kind: "image", objectUrl, name });
        }
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Could not load this document.",
        });
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId]);

  return state;
}
