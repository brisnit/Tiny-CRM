"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Download, FileUp, Loader2, Paperclip, RotateCcw, Trash2, X } from "lucide-react";
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
};

export function DocumentsPanel({
  projectId,
  documents,
  allowedExtensions,
  canUpload,
  variant = "panel",
}: {
  projectId: string;
  documents: DocumentView[];
  allowedExtensions: readonly string[];
  canUpload: boolean;
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

  function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files ?? []);
    // Reset immediately so the same file can be picked again after a failure.
    event.target.value = "";
    if (chosen.length > 0) void enqueue(chosen);
  }

  const body = (
    <>
      {canUpload ? (
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
              canUpload
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

/** One stored document. Matches RelatedList's row geometry exactly. */
function DocumentRow({
  document,
  onOpen,
  onDelete,
}: {
  document: DocumentView;
  onOpen: () => void;
  onDelete: () => void;
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
