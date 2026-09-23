"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Download, FileQuestion, Loader2, ZoomIn, ZoomOut } from "lucide-react";

import { DocumentIcon } from "@/components/app/documents/document-icon";
import { useDocumentPreview } from "@/components/app/documents/use-document-preview";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { formatBytes } from "@/lib/utils";

/**
 * The in-app document viewer.
 *
 * Renders the file itself rather than delegating to the browser: PDFs are
 * painted onto a canvas by PDF.js, images are shown from a blob URL built out
 * of bytes we fetched. Nothing is framed, embedded or served inline, so
 * `frame-src 'none'`, `object-src 'none'` and the attachment disposition on
 * every stored object all stay exactly as they were.
 *
 * Preview and download stay separate capabilities throughout: this asks for a
 * short-lived signed URL and reads bytes from it, while the Download button is
 * still the route that redirects the browser and saves the file.
 */

/**
 * PDF.js is ~1 MB and arrives only when a PDF is actually opened. `ssr: false`
 * because it is a canvas renderer with no server rendering to do.
 */
const PdfView = dynamic(
  () => import("@/components/app/documents/pdf-view").then((m) => m.PdfView),
  {
    ssr: false,
    loading: () => <Centered><Loader2 className="size-5 animate-spin text-faint" /></Centered>,
  },
);

export type ViewerDocument = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

export function DocumentViewer({
  document,
  onOpenChange,
}: {
  document: ViewerDocument;
  onOpenChange: (open: boolean) => void;
}) {
  const preview = useDocumentPreview(document.id);
  // A render failure inside PDF.js happens after the fetch succeeded, so it is
  // held here rather than in the hook.
  const [renderError, setRenderError] = React.useState<string | null>(null);
  const onRenderError = React.useCallback((message: string) => setRenderError(message), []);

  const downloadHref = `/api/files/${document.id}/download`;

  return (
    // Radix handles Escape, the focus trap and returning focus to the trigger.
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        width="2xl"
        className="flex h-[85vh] max-h-[85vh] flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="shrink-0 border-b border-hairline px-4 py-3">
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-8">
            <DocumentIcon mimeType={document.mimeType} />
            <span className="truncate">{document.name}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Viewing {document.name}. Press Escape to close.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          {renderError ? (
            <Failed message={renderError} href={downloadHref} name={document.name} />
          ) : preview.status === "loading" ? (
            <Centered>
              <Loader2 className="size-5 animate-spin text-faint" />
              <span className="text-[12.5px] text-muted">Loading {formatBytes(document.sizeBytes)}…</span>
            </Centered>
          ) : preview.status === "error" ? (
            <Failed message={preview.message} href={downloadHref} name={document.name} />
          ) : preview.status === "unsupported" ? (
            <Unsupported document={document} href={downloadHref} />
          ) : preview.kind === "pdf" ? (
            <PdfView data={preview.data} onError={onRenderError} />
          ) : (
            <ImageView src={preview.objectUrl} alt={document.name} />
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-hairline px-4 py-2.5">
          <span className="truncate text-[12px] text-muted">{formatBytes(document.sizeBytes)}</span>
          <Button asChild variant="outline" size="sm">
            {/* Still the download route, still forced as an attachment. */}
            <a href={downloadHref} download>
              <Download className="size-3.5" />
              Download
            </a>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** An image, from bytes already fetched. Never a remote `src`. */
function ImageView({ src, alt }: { src: string; alt: string }) {
  const [zoom, setZoom] = React.useState<number | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto bg-sunken p-4">
        <div className="flex min-h-full items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            className="rounded-lg bg-white shadow-pop"
            style={
              zoom === null
                ? { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }
                : { width: `${zoom * 100}%`, maxWidth: "none" }
            }
          />
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-1 border-t border-hairline px-4 py-2.5">
        <Button
          variant="ghost" size="icon-sm" aria-label="Zoom out"
          onClick={() => setZoom((z) => Math.max(0.25, (z ?? 1) - 0.25))}
        >
          <ZoomOut className="size-4" />
        </Button>
        <span className="min-w-[3.5rem] text-center text-[12.5px] tabular-nums text-muted">
          {zoom === null ? "Fit" : `${Math.round(zoom * 100)}%`}
        </span>
        <Button
          variant="ghost" size="icon-sm" aria-label="Zoom in"
          onClick={() => setZoom((z) => Math.min(4, (z ?? 1) + 0.25))}
        >
          <ZoomIn className="size-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setZoom(null)}>Fit</Button>
      </div>
    </div>
  );
}

function Unsupported({ document, href }: { document: ViewerDocument; href: string }) {
  return (
    <Centered>
      <DocumentIcon mimeType={document.mimeType} className="size-6" />
      <p className="text-[13px] font-medium text-body">No preview for this file type</p>
      <p className="max-w-sm text-center text-[12.5px] text-muted">
        {document.mimeType} · {formatBytes(document.sizeBytes)}. Download it to open in the
        application it belongs to.
      </p>
      <Button asChild variant="outline" size="sm">
        <a href={href} download><Download className="size-3.5" />Download</a>
      </Button>
    </Centered>
  );
}

/** Any failure still offers the thing that definitely works. */
function Failed({ message, href, name }: { message: string; href: string; name: string }) {
  return (
    <Centered>
      <FileQuestion className="size-6 text-faint" aria-hidden />
      <p className="text-[13px] font-medium text-body">This document could not be displayed</p>
      <p className="max-w-sm text-center text-[12.5px] text-muted">{message}</p>
      <Button asChild variant="outline" size="sm">
        <a href={href} download><Download className="size-3.5" />Download {name}</a>
      </Button>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8">{children}</div>
  );
}
