import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A deliberately small markdown renderer for AI output.
 *
 * Everything rendered here originates from a model, so nothing is passed to
 * `dangerouslySetInnerHTML` — inline formatting is parsed into React nodes and
 * any HTML in the source is rendered as literal text. That closes the obvious
 * injection path without pulling in a sanitiser dependency.
 *
 * It supports what the prompts actually ask for: headings, bullets, numbered
 * lists, bold, italic, inline code and links.
 */
export function Markdown({ content, className }: { content: string; className?: string }) {
  const blocks = React.useMemo(() => parseBlocks(content), [content]);

  return (
    <div className={cn("space-y-2.5 text-[13px] leading-relaxed text-body", className)}>
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading":
            return (
              <h4 key={i} className="pt-1 text-[13px] font-semibold tracking-[-0.01em] text-body">
                {inline(block.text)}
              </h4>
            );
          case "bullets":
            return (
              <ul key={i} className="space-y-1.5">
                {block.items.map((item, j) => (
                  <li key={j} className="flex gap-2">
                    <span className="mt-[7px] size-1 shrink-0 rounded-full bg-brand-400" aria-hidden />
                    <span className="min-w-0 flex-1">{inline(item)}</span>
                  </li>
                ))}
              </ul>
            );
          case "numbers":
            return (
              <ol key={i} className="space-y-1.5">
                {block.items.map((item, j) => (
                  <li key={j} className="flex gap-2">
                    <span className="mt-px w-4 shrink-0 text-right text-[11px] font-semibold text-faint tabular">
                      {j + 1}.
                    </span>
                    <span className="min-w-0 flex-1">{inline(item)}</span>
                  </li>
                ))}
              </ol>
            );
          default:
            return (
              <p key={i} className="text-pretty">
                {inline(block.text)}
              </p>
            );
        }
      })}
    </div>
  );
}

type Block =
  | { type: "paragraph"; text: string }
  | { type: "heading"; text: string }
  | { type: "bullets"; items: string[] }
  | { type: "numbers"; items: string[] };

function parseBlocks(content: string): Block[] {
  const lines = content.replace(/\r/g, "").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let bullets: string[] = [];
  let numbers: string[] = [];

  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    if (bullets.length) blocks.push({ type: "bullets", items: bullets });
    if (numbers.length) blocks.push({ type: "numbers", items: numbers });
    paragraph = [];
    bullets = [];
    numbers = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      flush();
      continue;
    }
    const heading = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push({ type: "heading", text: heading[1]! });
      continue;
    }
    const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      if (paragraph.length || numbers.length) flush();
      bullets.push(bullet[1]!);
      continue;
    }
    const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (numbered) {
      if (paragraph.length || bullets.length) flush();
      numbers.push(numbered[1]!);
      continue;
    }
    if (bullets.length || numbers.length) flush();
    paragraph.push(trimmed);
  }
  flush();
  return blocks;
}

/** Parses **bold**, *italic*, `code` and [links](url) into React nodes. */
function inline(text: string): React.ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  const parts = text.split(pattern).filter(Boolean);

  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-body">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="rounded bg-sunken px-1 py-0.5 font-mono text-[11px] text-body">
          {part.slice(1, -1)}
        </code>
      );
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = link[2]!;
      // Only allow safe schemes; anything else renders as plain text.
      if (/^(https?:|\/)/i.test(href)) {
        return (
          <a key={i} href={href} className="text-brand-600 underline underline-offset-2 hover:text-brand-700 dark:text-brand-400">
            {link[1]}
          </a>
        );
      }
      return <span key={i}>{link[1]}</span>;
    }
    return <span key={i}>{part}</span>;
  });
}
