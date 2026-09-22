import { File, FileImage, FileSpreadsheet, FileText, Presentation } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The icon for a document, chosen from its MIME type.
 *
 * The type is the one the *server* determined from the extension and the magic
 * bytes (src/lib/uploads.ts), not anything a browser claimed, so this is a
 * faithful picture of what was stored rather than a decoration on a guess.
 *
 * Deliberately coarse. Five shapes are enough to scan a list by, and a
 * per-format icon set would be a lot of surface for very little recognition.
 *
 * Each branch returns its element rather than selecting a component into a
 * variable and rendering that: a component value produced during render is a
 * new type on every pass, which remounts the subtree and which the lint rules
 * here reject on sight.
 */
export function DocumentIcon({ mimeType, className }: { mimeType: string; className?: string }) {
  const shared = cn("size-4 shrink-0 text-faint", className);

  if (mimeType.startsWith("image/")) return <FileImage className={shared} aria-hidden />;
  if (mimeType === "application/pdf") return <FileText className={shared} aria-hidden />;
  if (mimeType.includes("spreadsheet") || mimeType.includes("csv")) {
    return <FileSpreadsheet className={shared} aria-hidden />;
  }
  if (mimeType.includes("presentation")) return <Presentation className={shared} aria-hidden />;
  if (mimeType.includes("word") || mimeType.startsWith("text/")) {
    return <FileText className={shared} aria-hidden />;
  }
  return <File className={shared} aria-hidden />;
}
