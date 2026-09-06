"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Bold, CheckSquare, FolderKanban, Heading2, Italic, List, Pin, Save, Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  convertNoteToProject, convertNoteToTask, deleteNote, togglePinNote, updateNote,
} from "@/lib/actions/notes";
import { cn } from "@/lib/utils";

/**
 * A small rich-text editor built on `contenteditable`.
 *
 * `document.execCommand` is deprecated but remains the only cross-browser way to
 * get formatting without a large editor dependency, and the output is a narrow
 * set of tags this app controls. If the note system grows, this is the seam
 * where a real editor (TipTap, Lexical) would slot in — nothing outside this
 * component knows how the HTML is produced.
 */
export function NoteEditor({
  noteId,
  title,
  body,
  pinned,
}: {
  noteId: string;
  title: string | null;
  body: string;
  pinned: boolean;
}) {
  const router = useRouter();
  const editorRef = React.useRef<HTMLDivElement>(null);
  const [draftTitle, setDraftTitle] = React.useState(title ?? "");
  const [dirty, setDirty] = React.useState(false);
  const [isPinned, setIsPinned] = React.useState(pinned);
  const [confirming, setConfirming] = React.useState(false);
  // Deleting a note destroys the only copy of its text, so a titled note asks
  // for its title back. The server checks this too — the dialog is a courtesy,
  // not the control.
  const [confirmation, setConfirmation] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  // Set the initial HTML once; React must not own this subtree afterwards or it
  // will fight the browser's own editing.
  React.useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== body) {
      editorRef.current.innerHTML = body;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  function format(command: string, value?: string) {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    setDirty(true);
  }

  function save() {
    startTransition(async () => {
      const result = await updateNote(noteId, {
        title: draftTitle,
        body: editorRef.current?.innerHTML ?? body,
      });
      if (result.ok) {
        setDirty(false);
        toast.success("Saved");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  // Ctrl/Cmd+S saves, because people expect it to.
  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty) save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1 border-b border-hairline px-3 py-2">
        <ToolbarButton onClick={() => format("bold")} label="Bold">
          <Bold className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton onClick={() => format("italic")} label="Italic">
          <Italic className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton onClick={() => format("formatBlock", "<h3>")} label="Heading">
          <Heading2 className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton onClick={() => format("insertUnorderedList")} label="Bullets">
          <List className="size-3.5" />
        </ToolbarButton>

        <div className="ml-auto flex items-center gap-1.5">
          <ToolbarButton
            active={isPinned}
            label={isPinned ? "Unpin" : "Pin"}
            onClick={() =>
              startTransition(async () => {
                const result = await togglePinNote(noteId);
                if (result.ok) {
                  setIsPinned(result.data.pinned);
                  router.refresh();
                }
              })
            }
          >
            <Pin className="size-3.5" />
          </ToolbarButton>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              startTransition(async () => {
                const result = await convertNoteToTask(noteId);
                if (result.ok) {
                  toast.success("Task created", { description: result.data.title });
                  router.refresh();
                } else toast.error(result.error);
              })
            }
          >
            <CheckSquare className="size-3.5" />
            To task
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              startTransition(async () => {
                const result = await convertNoteToProject(noteId);
                if (result.ok) {
                  toast.success("Project created", { description: result.data.name });
                  router.push(`/projects/${result.data.id}` as never);
                } else toast.error(result.error);
              })
            }
          >
            <FolderKanban className="size-3.5" />
            To project
          </Button>
          <Button size="xs" variant="ghost" onClick={() => {
              setConfirmation("");
              setConfirming(true);
            }}>
            <Trash2 className="size-3.5" />
          </Button>
          <Button size="xs" variant={dirty ? "brand" : "subtle"} onClick={save} loading={pending} disabled={!dirty}>
            <Save className="size-3.5" />
            {dirty ? "Save" : "Saved"}
          </Button>
        </div>
      </div>

      <div className="p-5">
        <Input
          value={draftTitle}
          onChange={(e) => {
            setDraftTitle(e.target.value);
            setDirty(true);
          }}
          placeholder="Untitled note"
          className="mb-4 h-auto border-0 bg-transparent px-0 text-[19px] font-semibold tracking-[-0.02em] shadow-none focus-visible:ring-0"
        />
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={() => setDirty(true)}
          className={cn(
            "prose-note min-h-[280px] text-[14px] leading-relaxed text-body outline-none",
            "[&_h3]:mb-1.5 [&_h3]:mt-4 [&_h3]:text-[15px] [&_h3]:font-semibold [&_h3]:tracking-[-0.01em]",
            "[&_p]:my-2",
            "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1",
            "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
            "[&_a]:text-brand-600 [&_a]:underline",
            "[&_strong]:font-semibold",
          )}
        />
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent width="sm">
          <DialogHeader>
            <DialogTitle>Delete this note?</DialogTitle>
            <DialogDescription>
              This cannot be undone. The note text is not kept anywhere else.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className={title ? "space-y-2" : "py-0"}>
            {title ? (
              <Field
                label={
                  <span>
                    Type <span className="font-mono font-semibold">{title}</span> to confirm
                  </span>
                }
                htmlFor="note-delete-confirmation"
              >
                <Input
                  id="note-delete-confirmation"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  autoComplete="off"
                  placeholder={title}
                />
              </Field>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={pending}
              disabled={
                Boolean(title) &&
                confirmation.trim().toLowerCase() !== title!.trim().toLowerCase()
              }
              onClick={() =>
                startTransition(async () => {
                  const result = await deleteNote(noteId, confirmation);
                  if (result.ok) {
                    toast.success("Note deleted");
                    router.push("/notes");
                  } else toast.error(result.error);
                })
              }
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  label,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "rounded-md p-1.5 transition-colors",
        active ? "bg-brand-50 text-brand-600 dark:bg-brand-950 dark:text-brand-400" : "text-muted hover:bg-sunken hover:text-body",
      )}
    >
      {children}
    </button>
  );
}
