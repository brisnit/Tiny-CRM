"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, FileUp, Loader2, Lock, Paperclip, RotateCcw, Sparkles, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { DeleteDocumentDialog } from "@/components/app/documents/delete-document-dialog";
import { DocumentViewer } from "@/components/app/documents/document-viewer";
import { DocumentIcon } from "@/components/app/documents/document-icon";
import { useDocumentUpload, type UploadItem } from "@/components/app/documents/use-document-upload";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/controls";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel, PanelHeader } from "@/components/ui/surface";
import { formatDay } from "@/lib/dates";
import { cn, formatBytes } from "@/lib/utils";

/**
 * Documents on a project.
 *
 * ---------------------------------------------------------------------------
 * Why this is not a RelatedList
 * ---------------------------------------------------------------------------
 *
 * `RelatedList` is a server component with a header slot and a row slot, and no
 * way into the body. Uploads in flight have to appear *among* the documents
 * that already exist — that is the whole feedback loop — so the list has to be
 * client-rendered. The row markup below is deliberately identical to
 * `RelatedList`'s so the two read as the same component.
 *
 * ---------------------------------------------------------------------------
 * The `variant` prop is the seam for a future tab
 * ---------------------------------------------------------------------------
 *
 * This component never fetches. The page hands it `documents`, which means
 * moving Documents from a panel in the project's main column to a tab of its
 * own is `variant="page"` inside a `TabsContent`, and nothing else. That was a
 * requirement of the design rather than a convenience.
 */

export type DocumentView = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** ISO-8601. Serialised by the server component, as every client island here expects. */
  createdAt: string;
  uploaderName: string | null;
  /** Whether *this* viewer may delete it. Decided on the server; see below. */
  canDelete: boolean;
  /**
   * Whether Tiny can answer questions about this document, and why not.
   *
   * `null` when Document Intelligence is not enabled for the workspace at all —
   * which is different from "not read yet" and must not show as a spinner that
   * never resolves. Supplied by the server because the four gates in front of
   * ingestion are server-side and a client cannot see them.
   */
  intelligence: DocumentIntelligenceState | null;
};

/**
 * What the panel can say about a document's readiness.
 *
 * Derived from `DocumentIngestion.status` rather than invented: `pending` and
 * `processing` are the states where an answer is not available yet, `ready` is
 * the only one where it is, and everything else is a terminal failure that the
 * person who uploaded the file needs to be told about rather than left to infer
 * from a question that answers badly.
 */
export type DocumentIntelligenceState =
  | { state: "absent" }
  | { state: "processing" }
  | { state: "ready"; pageCount: number | null }
  | { state: "failed"; reason: string };

export function DocumentsPanel({
  projectId,
  documents,
  allowedExtensions,
  canUpload,
  uploadsIncludedInPlan = true,
  variant = "panel",
}: {
  projectId: string;
  documents: DocumentView[];
  allowedExtensions: readonly string[];
  /** The role question: may this member add records here at all. */
  canUpload: boolean;
  /**
   * The plan question, which is a different one. Free does not include
   * uploading, so the control is shown disabled with the reason rather than
   * hidden: a panel that simply has no way to add anything reads as broken,
   * and a control that accepts a file and then fails reads as worse. Server
   * enforcement is unchanged either way — `requireFileUploadEntitlement` runs
   * on both upload steps from the same read that produced this.
   */
  uploadsIncludedInPlan?: boolean;
  variant?: "panel" | "page";
}) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [deleting, setDeleting] = React.useState<DocumentView | null>(null);
  const [viewing, setViewing] = React.useState<DocumentView | null>(null);

  const { items, enqueue, retry, dismiss, clearCompleted } = useDocumentUpload({
    projectId,
    allowedExtensions,
    onSettled: ({ succeeded, failed }) => {
      if (succeeded > 0) router.refresh();

      if (failed === 0 && succeeded > 0) {
        toast.success(succeeded === 1 ? "Document uploaded" : `${succeeded} documents uploaded`);
        clearCompleted();
      } else if (succeeded > 0) {
        // Partial. The failures stay on screen with their reason and a retry,
        // so the summary says what happened rather than claiming success.
        toast.error(`${succeeded} of ${succeeded + failed} uploaded`, {
          description: "The rest are listed with what went wrong.",
        });
        clearCompleted();
      } else if (failed > 0) {
        toast.error(failed === 1 ? "That upload failed" : `${failed} uploads failed`);
      }
    },
  });

  const busy = items.some((item) => item.status !== "done" && item.status !== "failed");

  /**
   * Opens Tiny AI pointed at one document.
   *
   * The same `tinycrm:ask-ai` event every other Ask control dispatches — the
   * only new thing is `type: "fileAsset"`, which switches the server to the
   * document agent. `/api/ai/chat` has accepted that focus type since the
   * feature shipped; nothing in the client could send it, so the feature was
   * complete and unreachable.
   */
  function askAboutDocument(document: DocumentView) {
    window.dispatchEvent(
      new CustomEvent("tinycrm:ask-ai", {
        detail: { focus: { type: "fileAsset", id: document.id, label: document.name }, question: null },
      }),
    );
  }

  function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files ?? []);
    // Reset immediately so the same file can be picked again after a failure.
    event.target.value = "";
    if (chosen.length > 0) void enqueue(chosen);
  }

  const body = (
    <>
      {canUpload && !uploadsIncludedInPlan ? (
        <div className="border-t border-hairline p-4">
          {/*
            A div, not a disabled <label>: a label wrapping no input is not a
            control, so nothing here is focusable or clickable and there is no
            file picker to open. `aria-disabled` states it for assistive
            technology without claiming to be a button that does nothing.
          */}
          <div
            aria-disabled="true"
            data-testid="upload-upgrade-prompt"
            className={cn(
              "flex items-center gap-3 rounded-lg border border-dashed border-hairline",
              "px-4 py-3.5 opacity-70",
            )}
          >
            <Lock className="size-4 shrink-0 text-faint" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-body">
                Upgrade to Plus to upload
              </span>
              <span className="block text-[12px] text-muted">
                Documents attached on a paid plan stay available to read and download.
              </span>
            </span>
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/billing">Upgrade</Link>
            </Button>
          </div>
        </div>
      ) : null}

      {canUpload && uploadsIncludedInPlan ? (
        <div className="border-t border-hairline p-4">
          <label
            className={cn(
              "flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-hairline-strong",
              "px-4 py-3.5 transition-colors hover:border-brand-400 hover:bg-brand-50/30 dark:hover:bg-brand-950/20",
              busy && "pointer-events-none opacity-60",
            )}
          >
            {busy ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-faint" />
            ) : (
              <FileUp className="size-4 shrink-0 text-faint" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-body">
                {busy ? "Uploading…" : "Add documents"}
              </span>
              <span className="block text-[12px] text-muted">
                Proposals, contracts and specs. Choose one or several.
              </span>
            </span>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={allowedExtensions.map((extension) => `.${extension}`).join(",")}
              className="sr-only"
              onChange={choose}
            />
          </label>
        </div>
      ) : null}

      {items.length > 0 ? (
        <ul className="divide-y divide-hairline border-t border-hairline">
          {items.map((item) => (
            <UploadRow key={item.id} item={item} onRetry={() => void retry(item.id)} onDismiss={() => dismiss(item.id)} />
          ))}
        </ul>
      ) : null}

      {documents.length === 0 && items.length === 0 ? (
        <div className="border-t border-hairline">
          <EmptyState
            compact
            title="No documents yet"
            description={
              canUpload && uploadsIncludedInPlan
                ? "Attach the proposal, the contract, the scope — whatever this project is agreed on."
                : "Nothing has been attached to this project."
            }
          />
        </div>
      ) : (
        <ul className="divide-y divide-hairline border-t border-hairline">
          {documents.map((document) => (
            <DocumentRow
              key={document.id}
              document={document}
              onOpen={() => setViewing(document)}
              onDelete={() => setDeleting(document)}
              onAsk={() => askAboutDocument(document)}
            />
          ))}
        </ul>
      )}
    </>
  );

  return (
    <>
      {variant === "panel" ? (
        <Panel>
          <PanelHeader
            title="Documents"
            icon={<Paperclip />}
            description={describe(documents.length)}
          />
          {body}
        </Panel>
      ) : (
        <div className="min-w-0">{body}</div>
      )}

      {viewing ? (
        <DocumentViewer
          document={viewing}
          onOpenChange={(open) => { if (!open) setViewing(null); }}
        />
      ) : null}

      {deleting ? (
        <DeleteDocumentDialog
          open
          onOpenChange={(next) => { if (!next) setDeleting(null); }}
          fileId={deleting.id}
          name={deleting.name}
        />
      ) : null}
    </>
  );
}

function describe(count: number): string {
  if (count === 0) return "Files attached to this project";
  return count === 1 ? "1 document" : `${count} documents`;
}

/**
 * Says whether Tiny can answer about this document, and offers to.
 *
 * Four states, because a question asked too early and a question asked about a
 * document that could not be read are different problems with different
 * remedies, and the panel used to show neither:
 *
 *   absent      Document Intelligence is not on for this workspace. Nothing is
 *               rendered — an "Ask" control that always refused would be worse
 *               than no control, and a spinner that never resolves worse still.
 *   processing  Uploaded, not read yet. Disabled, and says so, rather than
 *               letting somebody ask and get "I haven't been able to read it".
 *   ready       The control, with the page count so the offer is concrete.
 *   failed      Named reason. These are terminal: retrying cannot make a
 *               scanned image have a text layer.
 */
function DocumentIntelligence({
  document,
  onAsk,
}: {
  document: DocumentView;
  onAsk: () => void;
}) {
  const intelligence = document.intelligence;
  if (!intelligence || intelligence.state === "absent") return null;

  if (intelligence.state === "processing") {
    return (
      <span
        className="flex items-center gap-1 px-1.5 text-[11px] text-faint"
        title="Tiny is reading this document. Questions can be asked once it is ready."
      >
        <Loader2 className="size-3 animate-spin" aria-hidden />
        Reading…
      </span>
    );
  }

  if (intelligence.state === "failed") {
    return (
      <span
        className="px-1.5 text-[11px] text-amber-700 dark:text-amber-500"
        title={`Tiny cannot answer questions about this document: ${intelligence.reason}`}
      >
        Cannot read
      </span>
    );
  }

  const pages = intelligence.pageCount;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onAsk}
      aria-label={
        `Ask Tiny AI about ${document.name}` +
        (pages ? `, ${pages} page${pages === 1 ? "" : "s"}` : "") +
        " — answered from this document only"
      }
      title={
        `Ask about ${document.name}. Answers come from this document only, with ` +
        `page citations${pages ? ` — ${pages} page${pages === 1 ? "" : "s"} read` : ""}.`
      }
    >
      <Sparkles className="size-3.5 text-brand-500" aria-hidden />
    </Button>
  );
}

/** One stored document. Matches RelatedList's row geometry exactly. */
function DocumentRow({
  document,
  onOpen,
  onDelete,
  onAsk,
}: {
  document: DocumentView;
  onOpen: () => void;
  onDelete: () => void;
  onAsk: () => void;
}) {
  const meta = [
    formatBytes(document.sizeBytes),
    document.uploaderName,
    formatDay(document.createdAt),
  ].filter(Boolean);

  return (
    <li className="group flex items-center gap-3 px-4 py-2.5">
      <DocumentIcon mimeType={document.mimeType} />
      {/* The name is the trigger. A button rather than a click handler on the
          row, so it is reachable by keyboard and announced as an action; the
          Download and Delete controls stay outside it rather than nested, which
          would be an interactive element inside another one. */}
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
        aria-label={`View ${document.name}`}
      >
        <span className="block truncate text-[13px] font-medium text-body hover:underline">
          {document.name}
        </span>
        <span className="block truncate text-[11.5px] text-muted">{meta.join(" · ")}</span>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {/* Whether Tiny can answer about this one, and the control to try.
            Rendered before Download so the readiness state reads next to the
            name rather than at the end of a row of icons. */}
        <DocumentIntelligence document={document} onAsk={onAsk} />
        {/* A real link, so the browser downloads it the way it downloads
            anything else. The route authorises, then redirects to a URL that
            lives for a minute; the bytes never pass through the app. */}
        <Button asChild variant="ghost" size="icon-sm" aria-label={`Download ${document.name}`}>
          <a href={`/api/files/${document.id}/download`} download>
            <Download className="size-3.5" />
          </a>
        </Button>
        {document.canDelete ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${document.name}`}
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** One upload in flight, or one that failed. */
function UploadRow({
  item,
  onRetry,
  onDismiss,
}: {
  item: UploadItem;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const failed = item.status === "failed";

  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      {failed ? (
        <X className="size-4 shrink-0 text-rose-500" aria-hidden />
      ) : (
        <Loader2 className="size-4 shrink-0 animate-spin text-faint" aria-hidden />
      )}

      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-body">{item.name}</div>
        {failed ? (
          <div className="truncate text-[11.5px] text-rose-600 dark:text-rose-400">{item.error}</div>
        ) : (
          <>
            <div className="truncate text-[11.5px] text-muted">{label(item)}</div>
            {item.status === "uploading" ? (
              <Progress
                value={item.percent}
                className="mt-1.5 h-1"
                // The default 500ms easing is tuned for the milestone bar and
                // lags visibly behind a real upload.
                barClassName="duration-150"
              />
            ) : null}
          </>
        )}
      </div>

      {failed ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="xs" onClick={onRetry}>
            <RotateCcw className="size-3.5" />
            Retry
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`Dismiss ${item.name}`} onClick={onDismiss}>
            <X className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function label(item: UploadItem): string {
  const size = formatBytes(item.sizeBytes);
  switch (item.status) {
    case "queued": return `${size} · waiting`;
    case "preparing": return `${size} · preparing`;
    case "uploading": return `${size} · ${item.percent}%`;
    case "confirming": return `${size} · checking`;
    case "done": return `${size} · done`;
    default: return size;
  }
}
