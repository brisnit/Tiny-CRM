/**
 * HTML sanitisation for stored rich text.
 *
 * Notes are authored in a contenteditable and shared across a workspace, so note
 * bodies are attacker-controlled content rendered in another user's session.
 * Before this module, `note-editor.tsx` assigned the stored string straight to
 * `innerHTML` — a stored, cross-user XSS.
 *
 * This is an allowlist sanitiser: anything not explicitly permitted is dropped.
 * It runs on write (so the database never holds a live payload) and again on
 * render (so rows written before this existed, or by any other path, are still
 * safe). Defence in depth is deliberate — a sanitiser that only runs in one
 * place fails open the moment a second write path appears.
 *
 * It is dependency-free and conservative. A richer editor should bring a
 * dedicated sanitiser (DOMPurify via jsdom, or `sanitize-html`); the call sites
 * would not change.
 */

const ALLOWED_TAGS = new Set([
  "p", "br", "b", "strong", "i", "em", "u", "s", "code", "pre",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "a", "span", "div", "hr",
]);

/** Attributes permitted per tag. Everything else is stripped. */
const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(["href", "title", "target", "rel"]),
};

const SAFE_URL = /^(https?:|mailto:|tel:|\/|#)/i;

/** Tags whose entire contents must be discarded, not just the tag itself. */
const DROP_CONTENT = /<(script|style|iframe|object|embed|noscript|template|svg|math)\b[\s\S]*?<\/\1\s*>/gi;
const DROP_VOID = /<(script|style|iframe|object|embed|link|meta|base|svg|math)\b[^>]*\/?>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;

export const MAX_HTML_LENGTH = 200_000;

export function sanitizeHtml(input: string | null | undefined): string {
  if (!input) return "";

  // Length cap first: a sanitiser should never be handed unbounded input.
  let html = String(input).slice(0, MAX_HTML_LENGTH);

  html = html.replace(COMMENTS, "");
  html = html.replace(DROP_CONTENT, "");
  html = html.replace(DROP_VOID, "");

  html = html.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
    (match, rawTag: string, rawAttrs: string) => {
      const tag = rawTag.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return "";
      if (match.startsWith("</")) return `</${tag}>`;

      const allowed = ALLOWED_ATTRIBUTES[tag];
      if (!allowed) return `<${tag}>`;

      const kept: string[] = [];
      const attrPattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
      let attr: RegExpExecArray | null;
      while ((attr = attrPattern.exec(rawAttrs)) !== null) {
        const name = attr[1]!.toLowerCase();
        const value = attr[3] ?? attr[4] ?? attr[5] ?? "";

        // Event handlers are never allowed, on any tag.
        if (name.startsWith("on")) continue;
        if (!allowed.has(name)) continue;
        if ((name === "href" || name === "src") && !SAFE_URL.test(value.trim())) continue;

        kept.push(`${name}="${escapeAttribute(value)}"`);
      }

      // Links that leave the app must not hand the opener window to the target.
      if (tag === "a" && kept.some((a) => a.startsWith("href="))) {
        const withoutRel = kept.filter((a) => !a.startsWith("rel=") && !a.startsWith("target="));
        return `<a ${withoutRel.join(" ")} target="_blank" rel="noopener noreferrer nofollow">`;
      }

      return kept.length ? `<${tag} ${kept.join(" ")}>` : `<${tag}>`;
    },
  );

  return html;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escapes a value for safe interpolation into HTML text. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Filenames are rendered in lists and used to build storage keys, so path
 * separators, control characters and leading dots are removed. Storage keys are
 * generated separately (see src/lib/storage.ts) — this value is for display.
 */
export function sanitizeFilename(name: string): string {
  const cleaned = Array.from(name)
    // Drop control characters by code point, so this source stays plain ASCII.
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join("")
    .replace(/[\\/]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .trim();
  return (cleaned || "file").slice(0, 200);
}


/**
 * Neutralises spreadsheet formula injection in CSV output.
 *
 * A contact field containing `=HYPERLINK(...)` becomes a live formula when the
 * export is opened in Excel or Sheets. Prefixing with a tab keeps the value
 * readable while stopping the parser treating it as a formula (OWASP guidance).
 */
export function neutralizeCsvCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `\t${value}` : value;
}
