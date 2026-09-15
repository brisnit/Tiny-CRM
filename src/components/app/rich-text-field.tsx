"use client";

import * as React from "react";
import { Bold, Heading2, Italic, List } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A compact rich-text field, for writing a note where you already are.
 *
 * Deliberately the same `contenteditable` approach as the full note editor
 * (note-editor.tsx), not a second editor with its own ideas: whatever this
 * produces is stored through the same allowlist sanitiser and must reopen
 * cleanly on the notes page. The same caveat applies too — `execCommand` is
 * deprecated but still the only dependency-free way to get formatting, and this
 * is the seam a real editor would replace.
 *
 * React writes the initial HTML once and then leaves the subtree alone. Owning
 * it would fight the browser's editing, which note-editor.tsx documents.
 *
 * `initialHtml` must already be sanitised. The notes data layer guarantees it.
 */
export type RichTextFieldHandle = {
  getHtml: () => string;
  focus: () => void;
};

type Props = {
  initialHtml?: string;
  placeholder?: string;
  ariaLabel: string;
  autoFocus?: boolean;
  onChange?: () => void;
  className?: string;
};

export const RichTextField = React.forwardRef<RichTextFieldHandle, Props>(function RichTextField(
  { initialHtml = "", placeholder, ariaLabel, autoFocus, onChange, className },
  ref,
) {
  const editorRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.innerHTML = initialHtml;
    if (autoFocus) el.focus();
    // Once per mount, by design; see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useImperativeHandle(
    ref,
    () => ({
      getHtml: () => editorRef.current?.innerHTML ?? "",
      focus: () => editorRef.current?.focus(),
    }),
    [],
  );

  function format(command: string, value?: string) {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    onChange?.();
  }

  return (
    <div className={cn("rounded-lg border border-hairline-strong bg-panel", className)}>
      <div className="flex items-center gap-0.5 border-b border-hairline px-1.5 py-1">
        <FormatButton label="Bold" onClick={() => format("bold")}>
          <Bold className="size-3.5" />
        </FormatButton>
        <FormatButton label="Italic" onClick={() => format("italic")}>
          <Italic className="size-3.5" />
        </FormatButton>
        <FormatButton label="Heading" onClick={() => format("formatBlock", "<h3>")}>
          <Heading2 className="size-3.5" />
        </FormatButton>
        <FormatButton label="Bullets" onClick={() => format("insertUnorderedList")}>
          <List className="size-3.5" />
        </FormatButton>
      </div>
      <div
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={() => onChange?.()}
        className={cn(
          "min-h-[96px] px-3 py-2.5 text-[13.5px] leading-relaxed text-body outline-none",
          "empty:before:pointer-events-none empty:before:text-faint empty:before:content-[attr(data-placeholder)]",
          NOTE_BODY_STYLES,
        )}
      />
    </div>
  );
});

/** Shared by the field and by read-only note bodies, so a note looks the same edited or not. */
export const NOTE_BODY_STYLES = cn(
  "[&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-[14px] [&_h3]:font-semibold [&_h3]:tracking-[-0.01em]",
  "[&_p]:my-1.5",
  "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-0.5",
  "[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_a]:text-brand-600 [&_a]:underline",
  "[&_strong]:font-semibold",
);

function FormatButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      // Keep focus in the editor, or the selection the command applies to is lost.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className="rounded-md p-1.5 text-muted transition-colors hover:bg-sunken hover:text-body"
    >
      {children}
    </button>
  );
}
