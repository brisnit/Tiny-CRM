import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { UPLOAD_ALLOWLIST, downloadHeaders, storageKeyFor, validateUpload } from "../../src/lib/uploads";
import { LIMITS } from "../../src/lib/validation/limits";

/**
 * Upload validation.
 *
 * Uploads are not enabled in this build, which is exactly why these tests exist:
 * the rules have to be correct *before* someone flips the flag, not after the
 * first malicious file.
 */

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HTML = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]); // <html>

const upload = (over: Partial<Parameters<typeof validateUpload>[0]> = {}) =>
  validateUpload({
    filename: "report.pdf",
    declaredMimeType: "application/pdf",
    sizeBytes: 1024,
    head: PDF,
    ...over,
  });

describe("upload validation", () => {
  test("accepts a genuine document", () => {
    const accepted = upload();
    assert.equal(accepted.extension, "pdf");
    assert.equal(accepted.mimeType, "application/pdf");
    assert.equal(accepted.displayName, "report.pdf");
  });

  test("rejects executable and script extensions", () => {
    for (const name of [
      "payload.exe", "run.sh", "a.bat", "x.ps1", "shell.php", "app.js",
      "page.html", "doc.xhtml", "thing.jar", "installer.msi",
    ]) {
      assert.throws(
        () => upload({ filename: name, declaredMimeType: "application/octet-stream", head: HTML }),
        `accepted ${name}`,
      );
    }
  });

  test("rejects SVG despite it being an image", () => {
    // SVG is an XML document that can carry script, and would execute on the
    // app's own origin if ever served inline.
    assert.throws(
      () => upload({ filename: "logo.svg", declaredMimeType: "image/svg+xml", head: HTML }),
      "an SVG was accepted",
    );
  });

  test("rejects a file whose contents contradict its extension", () => {
    // The classic: an HTML page named .pdf, which some browsers will render.
    assert.throws(
      () => upload({ filename: "invoice.pdf", declaredMimeType: "application/pdf", head: HTML }),
      "a disguised HTML file was accepted as a PDF",
    );
  });

  test("rejects a declared type that contradicts the extension", () => {
    assert.throws(
      () => upload({ filename: "photo.png", declaredMimeType: "text/html", head: PNG }),
      "a mismatched Content-Type was accepted",
    );
  });

  test("does not trust the declared type over the signature", () => {
    // Declaring the right type does not rescue the wrong bytes.
    assert.throws(
      () => upload({ filename: "photo.png", declaredMimeType: "image/png", head: HTML }),
      "the browser's Content-Type overrode the file signature",
    );
  });

  test("rejects a double extension", () => {
    assert.throws(
      () => upload({ filename: "report.pdf.exe", declaredMimeType: "application/pdf", head: PDF }),
      "a double extension was accepted",
    );
  });

  test("neutralises traversal in the display name", () => {
    const accepted = upload({ filename: "../../etc/report.pdf" });
    assert.ok(!accepted.displayName.includes("/"), "a path separator survived");
    assert.ok(!accepted.displayName.includes(".."), "a traversal sequence survived");
  });

  test("rejects an empty or oversized file", () => {
    assert.throws(() => upload({ sizeBytes: 0 }), "an empty file was accepted");
    assert.throws(
      () => upload({ sizeBytes: LIMITS.maxUploadBytes + 1 }),
      "an oversized file was accepted",
    );
  });

  test("rejects a file with no extension at all", () => {
    assert.throws(() => upload({ filename: "README" }), "an extensionless file was accepted");
  });

  test("the allowlist contains no executable or markup format", () => {
    for (const extension of UPLOAD_ALLOWLIST) {
      assert.ok(
        !["svg", "html", "htm", "js", "exe", "sh", "php", "xml"].includes(extension),
        `the allowlist contains a dangerous format: ${extension}`,
      );
    }
  });
});

describe("storage keys", () => {
  test("are workspace-partitioned, random, and carry no user input", () => {
    const a = storageKeyFor("ws_alpha", "pdf");
    const b = storageKeyFor("ws_alpha", "pdf");

    assert.match(a, /^workspaces\/ws_alpha\/[0-9a-f-]{36}\.pdf$/);
    assert.notEqual(a, b, "two uploads produced the same key");
  });
});

describe("download headers", () => {
  test("force a download and block execution in the app origin", () => {
    const headers = downloadHeaders({ displayName: "report.pdf", mimeType: "application/pdf" }) as
      Record<string, string>;

    assert.match(headers["Content-Disposition"]!, /^attachment;/, "the file would render inline");
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.match(headers["Content-Security-Policy"]!, /default-src 'none'/);
    assert.match(headers["Cache-Control"]!, /no-store/);
  });

  test("a quote in the filename cannot break out of the header", () => {
    const headers = downloadHeaders({
      displayName: 'evil".pdf',
      mimeType: "application/pdf",
    }) as Record<string, string>;
    assert.equal(
      (headers["Content-Disposition"]!.match(/"/g) ?? []).length,
      2,
      "a quote in the filename escaped the header value",
    );
  });
});
