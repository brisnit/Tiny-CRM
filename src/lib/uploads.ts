import "server-only";

import { AppError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { sanitizeFilename } from "@/lib/sanitize";
import { LIMITS } from "@/lib/validation/limits";

/**
 * File upload security.
 *
 * Uploads are **not enabled** in this build: the `files` feature flag defaults
 * to off and no storage driver is configured, so `STORAGE_DRIVER=none` is the
 * shipped state. This module exists so that turning them on is a configuration
 * change rather than a security project — every rule an upload has to satisfy is
 * written down and enforced here, ahead of the pipeline that will call it.
 *
 * The rules, and why each one is here rather than "obvious":
 *
 *  - **An allowlist, never a blocklist.** A blocklist is a list of the attacks
 *    someone thought of. `.svg` is excluded from that allowlist despite being an
 *    image, because SVG is an XML document that can carry script and would run
 *    on the app's own origin if ever served inline.
 *  - **The declared type is a hint, not evidence.** A browser sends whatever
 *    `Content-Type` it likes. The magic bytes are checked against the claim, and
 *    a mismatch is rejected — that is what stops `invoice.pdf` from actually
 *    being an HTML page.
 *  - **The stored name is never the supplied name.** Files are stored under a
 *    generated key; the original name is a display label only. A name can carry
 *    traversal, control characters, or a double extension.
 *  - **Served from a separate origin, or as an attachment.** Serving
 *    user-uploaded content from the app's origin makes any file-typing mistake
 *    into stored XSS with a session cookie attached.
 *  - **Scanning is a hook, and it is honest about being empty.** There is no
 *    malware scanner behind `scanForMalware`; it fails closed when a scanner is
 *    required by configuration and is otherwise a documented no-op.
 */

/** Extensions and their permitted magic-byte signatures. */
const ALLOWED: Record<string, { mime: string[]; magic?: number[][] }> = {
  pdf: { mime: ["application/pdf"], magic: [[0x25, 0x50, 0x44, 0x46]] }, // %PDF
  png: { mime: ["image/png"], magic: [[0x89, 0x50, 0x4e, 0x47]] },
  jpg: { mime: ["image/jpeg"], magic: [[0xff, 0xd8, 0xff]] },
  jpeg: { mime: ["image/jpeg"], magic: [[0xff, 0xd8, 0xff]] },
  gif: { mime: ["image/gif"], magic: [[0x47, 0x49, 0x46, 0x38]] },
  webp: { mime: ["image/webp"], magic: [[0x52, 0x49, 0x46, 0x46]] },
  // Office formats are ZIP containers; the signature is the ZIP one.
  docx: {
    mime: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    magic: [[0x50, 0x4b, 0x03, 0x04]],
  },
  xlsx: {
    mime: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    magic: [[0x50, 0x4b, 0x03, 0x04]],
  },
  pptx: {
    mime: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    magic: [[0x50, 0x4b, 0x03, 0x04]],
  },
  csv: { mime: ["text/csv", "application/csv", "text/plain"] },
  txt: { mime: ["text/plain"] },
  md: { mime: ["text/markdown", "text/plain"] },
};

/**
 * Extensions refused outright even if some future edit adds them above. Listed
 * separately so the refusal survives a careless change to the allowlist.
 */
const NEVER = new Set([
  "svg", "html", "htm", "xhtml", "xml", "js", "mjs", "jsx", "ts",
  "exe", "dll", "so", "dylib", "bat", "cmd", "com", "scr", "msi",
  "sh", "bash", "zsh", "ps1", "vbs", "jar", "app", "dmg", "pkg",
  "php", "asp", "aspx", "jsp", "cgi", "pl", "py", "rb",
]);

export type UploadCandidate = {
  /** The name as supplied by the browser. Untrusted. */
  filename: string;
  /** The Content-Type as supplied by the browser. Untrusted. */
  declaredMimeType: string;
  sizeBytes: number;
  /** At least the first 16 bytes, for signature checking. */
  head: Uint8Array;
};

export type AcceptedUpload = {
  /** Safe display name. Never used as a filesystem path. */
  displayName: string;
  extension: string;
  /** The type the server determined, not the one the browser claimed. */
  mimeType: string;
  sizeBytes: number;
};

/**
 * Validates an upload. Throws an `AppError` describing the first failure; the
 * caller writes nothing until this returns.
 */
export function validateUpload(candidate: UploadCandidate): AcceptedUpload {
  const displayName = sanitizeFilename(candidate.filename);
  const extension = extensionOf(displayName);

  if (!extension) {
    throw new AppError("validation", "That file has no extension, so its type cannot be confirmed.");
  }
  if (NEVER.has(extension)) {
    throw new AppError("validation", `.${extension} files cannot be uploaded.`);
  }

  const rule = ALLOWED[extension];
  if (!rule) {
    throw new AppError(
      "validation",
      `.${extension} files are not accepted. Allowed: ${Object.keys(ALLOWED).join(", ")}.`,
    );
  }

  if (candidate.sizeBytes <= 0) {
    throw new AppError("validation", "That file is empty.");
  }
  if (candidate.sizeBytes > LIMITS.maxUploadBytes) {
    const mb = Math.floor(LIMITS.maxUploadBytes / 1024 / 1024);
    throw new AppError("validation", `Files must be ${mb} MB or smaller.`);
  }

  // The declared type must be one the extension permits. This is not a security
  // control on its own — the browser controls it — but a mismatch is a strong
  // signal and rejecting it early keeps the signature check meaningful.
  const declared = candidate.declaredMimeType.split(";")[0]!.trim().toLowerCase();
  if (declared && !rule.mime.includes(declared)) {
    throw new AppError(
      "validation",
      "That file's type does not match its extension.",
      { meta: { field: "file" } },
    );
  }

  // The signature is the actual evidence. Plain-text formats have none, which is
  // why they are also the formats that carry the least risk.
  if (rule.magic && !rule.magic.some((signature) => startsWith(candidate.head, signature))) {
    throw new AppError(
      "validation",
      "That file's contents do not match its extension.",
      { meta: { field: "file" } },
    );
  }

  return {
    displayName,
    extension,
    // The server's determination, not the browser's claim.
    mimeType: rule.mime[0]!,
    sizeBytes: candidate.sizeBytes,
  };
}

/**
 * Generates the key a file is stored under.
 *
 * Workspace-prefixed so a storage-level listing is still tenant-partitioned, and
 * random rather than derived from the filename so two uploads never collide and
 * a key is not guessable from a display name.
 */
export function storageKeyFor(workspaceId: string, extension: string): string {
  const random = globalThis.crypto.randomUUID();
  return `workspaces/${workspaceId}/${random}.${extension}`;
}

/**
 * Malware scanning hook.
 *
 * **There is no scanner behind this.** It is a seam, not a control, and it says
 * so rather than returning `true` and letting a reader assume otherwise.
 *
 * With `REQUIRE_MALWARE_SCAN=true` and no scanner wired in, this throws — so a
 * deployment that believes it is scanning cannot accept an unscanned file.
 * Without it, the upload proceeds and the absence is logged, once per file, at
 * warning level.
 */
export async function scanForMalware(key: string): Promise<{ scanned: boolean }> {
  const required = process.env.REQUIRE_MALWARE_SCAN === "true";

  if (required) {
    throw new AppError(
      "internal",
      "Uploads are unavailable right now.",
      {
        internal:
          "REQUIRE_MALWARE_SCAN is set but no scanner is configured. Wire one into " +
          "scanForMalware() in src/lib/uploads.ts, or unset the variable.",
      },
    );
  }

  log.warn("upload stored without malware scanning", { key });
  return { scanned: false };
}

/**
 * Response headers for serving a stored file.
 *
 * `Content-Disposition: attachment` plus `nosniff` is what keeps a
 * mis-identified file from executing in the app's origin. Serving user content
 * from a separate origin is better still, and is what `STORAGE_PUBLIC_HOST`
 * exists for.
 */
export function downloadHeaders(file: { displayName: string; mimeType: string }): HeadersInit {
  return {
    "Content-Type": file.mimeType,
    "Content-Disposition": `attachment; filename="${file.displayName.replace(/"/g, "")}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, no-store",
  };
}

function extensionOf(name: string): string | null {
  const index = name.lastIndexOf(".");
  if (index <= 0 || index === name.length - 1) return null;
  return name.slice(index + 1).toLowerCase();
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, i) => bytes[i] === byte);
}

export const UPLOAD_ALLOWLIST = Object.keys(ALLOWED);
