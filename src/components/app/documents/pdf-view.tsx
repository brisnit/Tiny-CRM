"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight, Loader2, Maximize2, ZoomIn, ZoomOut } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * A PDF, painted onto a canvas by PDF.js.
 *
 * ---------------------------------------------------------------------------
 * Why a canvas and not an iframe
 * ---------------------------------------------------------------------------
 *
 * An `<iframe>` or `<embed>` would hand the file to the browser *as a
 * document*, which is the one thing this product does not do with user
 * uploads. `frame-src 'none'` and `object-src 'none'` say so, and they stay.
 * Here the file is never a document: it is an array of bytes that we read and
 * turn into pixels. A mis-typed file cannot execute anywhere, on any origin.
 *
 * ---------------------------------------------------------------------------
 * eval, and why nothing is passed to disable it
 * ---------------------------------------------------------------------------
 *
 * The plan for this work said to set `isEvalSupported: false`, because older
 * PDF.js compiled some font programs with `eval` and production `script-src`
 * carries no `'unsafe-eval'` — a viewer that works locally and throws in
 * production.
 *
 * That option no longer exists. It was removed from pdfjs-dist v6 along with
 * the behaviour: the shipped `pdf.min.mjs` and `pdf.worker.min.mjs` contain no
 * `eval(` and no `new Function(` at all, which was verified against the
 * installed build rather than assumed from the changelog. Passing the option
 * now would be a type error, and — worse — a comment claiming a protection that
 * is not doing anything. If this dependency is ever upgraded, re-check that.
 *
 * `isOffscreenCanvasSupported: false` keeps rendering on the canvas we control
 * rather than one handed to a worker.
 *
 * The document is handed to PDF.js as bytes we already hold, so it performs no
 * network I/O of its own: no ranged refetching, and no signed URL that has to
 * outlive the first request. A PDF relying on non-embedded standard fonts will
 * render with a substitute, which is a cosmetic cost we accept rather than
 * shipping a font bundle for this phase.
 *
 * The worker is loaded from our own origin, satisfying `worker-src 'self'`.
 * Nothing here needs a CSP change.
 */

// Loaded lazily so ~1 MB of PDF.js never enters the main bundle; it arrives
// only when somebody opens a PDF.
type PdfModule = typeof import("pdfjs-dist");
let pdfjs: PdfModule | null = null;

async function loadPdfjs(): Promise<PdfModule> {
  if (pdfjs) return pdfjs;
  pdfjs = await import("pdfjs-dist");
  return pdfjs;
}

/**
 * The worker, constructed rather than named.
 *
 * `GlobalWorkerOptions.workerSrc = new URL(…).toString()` is the form most
 * examples use, and it does not survive this toolchain: the bundler sees a
 * string, not an asset reference, so in development the URL resolves to
 * nothing. PDF.js then waits for a worker that never arrives — `getDocument`
 * neither resolves nor rejects, and the viewer sits on a blank canvas with no
 * error to explain it. That is exactly how this failed the first time.
 *
 * `new Worker(new URL(…), { type: "module" })` is statically analysable, so the
 * bundler emits the file and rewrites the reference. It is served from our own
 * origin, which is what `worker-src 'self'` permits — no CSP change.
 *
 * One worker per open document, torn down with it, so a closed viewer leaves no
 * thread behind and the next open is not using a port somebody already killed.
 */
function createWorker(mod: PdfModule) {
  const port = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), {
    type: "module",
  });
  // `PDFWorker.create` rather than the constructor: it is the documented
  // factory and the one whose typing accepts a port.
  return { worker: mod.PDFWorker.create({ port }), port };
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

export function PdfView({ data, onError }: { data: ArrayBuffer; onError: (message: string) => void }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const shellRef = React.useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docRef = React.useRef<any>(null);
  // `destroy()` lives on the loading task in v6, not on the document proxy;
  // it is what tears the worker down.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const taskRef = React.useRef<any>(null);
  const workerRef = React.useRef<{ worker: { destroy(): void }; port: Worker } | null>(null);

  const [pages, setPages] = React.useState(0);
  const [page, setPage] = React.useState(1);
  /** null means fit-to-width, which is recomputed as the viewport changes. */
  const [zoom, setZoom] = React.useState<number | null>(null);
  const [rendering, setRendering] = React.useState(true);

  // --- open the document ---------------------------------------------------
  React.useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const mod = await loadPdfjs();
        // A copy: PDF.js transfers ownership of the buffer it is given, which
        // would detach the one the viewer holds for a retry or a download.
        const spawned = createWorker(mod);
        workerRef.current = spawned;

        const task = mod.getDocument({
          data: new Uint8Array(data.slice(0)),
          worker: spawned.worker,
          isOffscreenCanvasSupported: false,
        });
        taskRef.current = task;
        const doc = await task.promise;
        if (cancelled) {
          void task.destroy();
          return;
        }
        docRef.current = doc;
        setPages(doc.numPages);
        setPage(1);
      } catch (error) {
        if (!cancelled) {
          onError(error instanceof Error ? error.message : "This PDF could not be opened.");
        }
      }
    })();

    return () => {
      cancelled = true;
      void taskRef.current?.destroy();
      taskRef.current = null;
      docRef.current = null;
      workerRef.current?.worker.destroy();
      workerRef.current?.port.terminate();
      workerRef.current = null;
    };
  }, [data, onError]);

  // --- paint the current page ----------------------------------------------
  React.useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas || pages === 0) return;

    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let task: any = null;

    void (async () => {
      setRendering(true);
      try {
        const pdfPage = await doc.getPage(page);
        if (cancelled) return;

        const unscaled = pdfPage.getViewport({ scale: 1 });
        const available = (shellRef.current?.clientWidth ?? unscaled.width) - 32;
        const scale = zoom ?? Math.min(available / unscaled.width, 2);
        const viewport = pdfPage.getViewport({ scale });

        // Render at device resolution so text is not soft on a retina display,
        // but lay out at CSS pixels.
        const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        const context = canvas.getContext("2d");
        if (!context) return;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);

        task = pdfPage.render({ canvasContext: context, viewport });
        await task.promise;
      } catch (error) {
        // A cancelled render is the expected result of paging quickly; it is
        // not a failure and must not replace the viewer with an error.
        const name = (error as { name?: string } | null)?.name;
        if (!cancelled && name !== "RenderingCancelledException") {
          onError(error instanceof Error ? error.message : "This page could not be drawn.");
        }
      } finally {
        if (!cancelled) setRendering(false);
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel?.();
    };
  }, [page, pages, zoom, onError]);

  // Fit-to-width follows the viewport, so a resized window or a rotated phone
  // re-lays out rather than keeping a scale computed for a different screen.
  React.useEffect(() => {
    if (zoom !== null) return;
    const onResize = () => setPage((current) => current);
    globalThis.addEventListener("resize", onResize);
    return () => globalThis.removeEventListener("resize", onResize);
  }, [zoom]);

  const stepZoom = (direction: 1 | -1) => {
    const current = zoom ?? 1;
    const index = ZOOM_STEPS.findIndex((z) => z >= current - 0.001);
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction))];
    setZoom(next ?? current);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={shellRef} className="min-h-0 flex-1 overflow-auto bg-sunken p-4">
        {/* The canvas exists only once a document has actually opened. An
            always-present canvas shows a blank white page while loading, and
            makes "a canvas is on screen" mean nothing to anyone testing this. */}
        {pages === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-faint" aria-label="Loading document" />
          </div>
        ) : (
          <div className="mx-auto w-fit">
            <canvas ref={canvasRef} className="block rounded-lg bg-white shadow-pop" />
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-hairline px-4 py-2.5">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost" size="icon-sm" aria-label="Previous page"
            disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-[5.5rem] text-center text-[12.5px] tabular-nums text-muted">
            {rendering ? <Loader2 className="inline size-3.5 animate-spin" /> : `${page} / ${pages || "–"}`}
          </span>
          <Button
            variant="ghost" size="icon-sm" aria-label="Next page"
            disabled={pages === 0 || page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>

        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label="Zoom out" onClick={() => stepZoom(-1)}>
            <ZoomOut className="size-4" />
          </Button>
          <span className="min-w-[3.5rem] text-center text-[12.5px] tabular-nums text-muted">
            {zoom === null ? "Fit" : `${Math.round(zoom * 100)}%`}
          </span>
          <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => stepZoom(1)}>
            <ZoomIn className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Fit to width" onClick={() => setZoom(null)}>
            <Maximize2 className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
