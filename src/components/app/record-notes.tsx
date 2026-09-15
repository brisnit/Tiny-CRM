"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ExternalLink, FileText, Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel, PanelHeader } from "@/components/ui/surface";
import { EmptyState } from "@/components/ui/empty-state";
import {
  NOTE_BODY_STYLES, RichTextField, type RichTextFieldHandle,
} from "@/components/app/rich-text-field";
import type { RecordLinks } from "@/components/app/timeline-composer";
import {
  archiveNote, createNote, restoreNote, togglePinNote, updateNote,
} from "@/lib/actions/notes";
import { sanitizeHtml } from "@/lib/sanitize";
import { cn } from "@/lib/utils";

/**
 * The notes on one record, and the one place they are written.
 *
 * Before this, an opportunity had two things called a note. The timeline's
 * *Note* button logged an activity; the Notes list showed `Note` records and
 * hid itself when there were none. So a note written from the obvious button
 * never appeared in the list, and the list was invisible until something else
 * put a note there. This panel is always visible, and everything it writes is a
 * real `Note` — which logs its own timeline entry, so history is kept without
 * a second concept.
 *
 * *Delete* moves a note to the Trash, with Undo. Members hold `record:archive`
 * but not `record:delete`, so a button that destroyed notes outright would be
 * refused for most of the people who use it; permanent deletion stays where it
 * was, on the note's own page and in the Trash, for roles that hold it.
 *
 * Every rule here is also enforced on the server. The permissions passed in
 * only decide which controls to show.
 */

export type NoteItem = {
  id: string;
  title: string | null;
  /** Sanitised HTML. Sanitised again before rendering regardless. */
  body: string;
  pinned: boolean;
  version: number;
  /** Pre-formatted on the server, e.g. "Britt · 3 days ago". */
  meta: string;
};

export type NotePermissions = {
  canCreate: boolean;
  canEdit: boolean;
  canArchive: boolean;
};

/** Whether composed HTML holds any actual words. */
function hasText(html: string): boolean {
  return html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").trim().length > 0;
}

export function RecordNotes({
  links,
  notes,
  permissions,
  className,
}: {
  links: RecordLinks;
  notes: NoteItem[];
  permissions: NotePermissions;
  className?: string;
}) {
  const router = useRouter();
  const [adding, setAdding] = React.useState(false);

  return (
    <Panel className={className}>
      <PanelHeader
        title="Notes"
        icon={<FileText />}
        description={
          notes.length === 0
            ? "What you learn about this, kept with it"
            : `${notes.length} note${notes.length === 1 ? "" : "s"}`
        }
        action={
          permissions.canCreate && !adding ? (
            <Button size="xs" variant="subtle" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" />
              Add note
            </Button>
          ) : null
        }
      />

      {adding ? (
        <div className="border-t border-hairline p-4">
          <NoteForm
            submitLabel="Save note"
            onCancel={() => setAdding(false)}
            onSubmit={async ({ title, body }) => {
              const result = await createNote({
                workspaceId: links.workspaceId,
                title: title || undefined,
                body,
                contactId: links.contactId ?? undefined,
                companyId: links.companyId ?? undefined,
                dealId: links.dealId ?? undefined,
                projectId: links.projectId ?? undefined,
                opportunityId: links.opportunityId ?? undefined,
              });
              if (!result.ok) {
                toast.error(result.error);
                return false;
              }
              toast.success("Note added");
              setAdding(false);
              router.refresh();
              return true;
            }}
          />
        </div>
      ) : null}

      {notes.length === 0 ? (
        adding ? null : (
          <div className="border-t border-hairline">
            <EmptyState
              compact
              title="No notes yet"
              description={
                permissions.canCreate
                  ? "Calls, requirements, decisions — anything worth remembering."
                  : "Nobody has written a note here yet."
              }
            />
          </div>
        )
      ) : (
        <ul className="divide-y divide-hairline border-t border-hairline">
          {notes.map((note) => (
            <NoteRow key={note.id} note={note} permissions={permissions} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function NoteRow({ note, permissions }: { note: NoteItem; permissions: NotePermissions }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const safeBody = React.useMemo(() => sanitizeHtml(note.body), [note.body]);

  if (editing) {
    return (
      <li className="p-4">
        <NoteForm
          initialTitle={note.title ?? ""}
          initialBody={safeBody}
          submitLabel="Save changes"
          onCancel={() => setEditing(false)}
          onSubmit={async ({ title, body }) => {
            const result = await updateNote(note.id, { title, body, version: note.version });
            if (!result.ok) {
              // Most often someone else saved first. Show their version rather
              // than leave a stale one on screen.
              toast.error(result.error);
              router.refresh();
              return false;
            }
            toast.success("Note saved");
            setEditing(false);
            router.refresh();
            return true;
          }}
        />
      </li>
    );
  }

  function remove() {
    startTransition(async () => {
      const result = await archiveNote(note.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.refresh();
      toast.success("Note deleted", {
        description: "It's in the Trash if you need it back.",
        action: {
          label: "Undo",
          onClick: async () => {
            const restored = await restoreNote(note.id);
            if (restored.ok) router.refresh();
            else toast.error(restored.error);
          },
        },
      });
    });
  }

  function pin() {
    startTransition(async () => {
      const result = await togglePinNote(note.id);
      if (result.ok) router.refresh();
      else toast.error(result.error);
    });
  }

  return (
    <li className="group px-4 py-3" aria-label={note.title ?? "Untitled note"}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {note.pinned ? (
              <Pin className="size-3 shrink-0 text-brand-600" aria-label="Pinned" />
            ) : null}
            <h4 className="truncate text-[13px] font-semibold text-body">
              {note.title ?? "Untitled note"}
            </h4>
          </div>
          <p className="mt-0.5 text-[11.5px] text-faint">{note.meta}</p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-60 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
          {permissions.canEdit ? (
            <>
              <IconButton label={note.pinned ? "Unpin note" : "Pin note"} onClick={pin} disabled={pending}>
                {note.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
              </IconButton>
              <IconButton label="Edit note" onClick={() => setEditing(true)} disabled={pending}>
                <Pencil className="size-3.5" />
              </IconButton>
            </>
          ) : null}
          {permissions.canArchive ? (
            <IconButton label="Delete note" onClick={remove} disabled={pending}>
              <Trash2 className="size-3.5" />
            </IconButton>
          ) : null}
          <Link
            href={`/notes/${note.id}` as never}
            title="Open note"
            aria-label="Open note"
            className="rounded-md p-1.5 text-muted transition-colors hover:bg-sunken hover:text-body"
          >
            <ExternalLink className="size-3.5" />
          </Link>
        </div>
      </div>

      {hasText(safeBody) ? (
        <div
          className={cn("mt-2 text-[13px] leading-relaxed text-body", NOTE_BODY_STYLES)}
          // Sanitised on write, by the data layer, and once more here.
          dangerouslySetInnerHTML={{ __html: safeBody }}
        />
      ) : null}
    </li>
  );
}

function NoteForm({
  initialTitle = "",
  initialBody = "",
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialTitle?: string;
  initialBody?: string;
  submitLabel: string;
  onSubmit: (value: { title: string; body: string }) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [title, setTitle] = React.useState(initialTitle);
  const [pending, startTransition] = React.useTransition();
  const field = React.useRef<RichTextFieldHandle>(null);

  function submit() {
    const body = field.current?.getHtml() ?? "";
    if (!title.trim() && !hasText(body)) {
      toast.error("Write something first.");
      field.current?.focus();
      return;
    }
    startTransition(async () => {
      await onSubmit({ title: title.trim(), body });
    });
  }

  return (
    <div
      className="space-y-2.5"
      onKeyDown={(event) => {
        // Cmd/Ctrl+Enter saves, Escape cancels — the note is the thing being typed.
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          submit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <Input
        aria-label="Note title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Title (optional)"
        maxLength={200}
      />
      <RichTextField
        ref={field}
        ariaLabel="Note text"
        initialHtml={initialBody}
        placeholder="What happened, what was decided, what to remember…"
        autoFocus
      />
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button size="sm" variant="brand" onClick={submit} loading={pending}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="rounded-md p-1.5 text-muted transition-colors hover:bg-sunken hover:text-body disabled:opacity-50"
    >
      {children}
    </button>
  );
}
