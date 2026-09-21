import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getStorage } from "../../src/lib/storage";

/**
 * The storage driver, against a real S3-compatible endpoint.
 *
 * These tests exist because the alternative — a filesystem stub — would prove
 * that a function can write a file while skipping every part of the production
 * path that can actually be wrong: SigV4 canonicalisation, presigned URL
 * expiry, which headers are signed, whether a ranged GET returns 206, what a
 * provider says when an object is missing.
 *
 * So there is one driver, and locally it points at MinIO (scripts/minio.mjs).
 * Production points the same code at Cloudflare R2. What passes here is the
 * behaviour production depends on, not an approximation of it.
 *
 * Skipped rather than failed when no endpoint is configured: with nothing to
 * talk to there is nothing to assert, and a green run that asserted nothing
 * would be worse than an honest skip.
 */

const configured = Boolean(process.env.S3_ENDPOINT);
const needsStorage = configured ? undefined : { skip: "no S3_ENDPOINT; run scripts/minio.mjs start" };

/** `%PDF-1.7` followed by filler, so there are at least 16 bytes to range over. */
const PDF: Uint8Array<ArrayBuffer> = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37,
  0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a, 0x31, 0x20, 0x30,
]);

const storage = getStorage();
const keys: string[] = [];

/** A fresh key per test, so nothing depends on ordering or on a clean bucket. */
function newKey(extension = "pdf"): string {
  const key = `workspaces/ws_storage_test/${randomUUID()}.${extension}`;
  keys.push(key);
  return key;
}

async function put(key: string, body: Uint8Array<ArrayBuffer>, downloadName = "document.pdf") {
  const contract = await storage.createUploadUrl({
    key,
    contentType: "application/pdf",
    downloadName,
  });
  const response = await fetch(contract.url, {
    method: contract.method,
    headers: contract.headers,
    body,
  });
  return { contract, response };
}

before(() => {
  if (configured) return;
  console.log("  (object storage suite skipped: no S3_ENDPOINT)");
});

after(async () => {
  if (!configured) return;
  // Leave the bucket as it was found.
  for (const key of keys) {
    try {
      await storage.deleteObject(key);
    } catch {
      // Best effort; a leftover object in a throwaway bucket is not a failure.
    }
  }
});

describe("the storage driver", { concurrency: false }, () => {
  test("is the S3 driver when an endpoint is configured", needsStorage, () => {
    assert.equal(storage.kind, "s3");
  });

  test("a presigned PUT stores the object", needsStorage, async () => {
    const key = newKey();
    const { contract, response } = await put(key, PDF);

    assert.ok(response.ok, `PUT failed: ${response.status}`);
    assert.equal(contract.method, "PUT");
    assert.ok(contract.expiresAt > new Date().toISOString(), "the contract is already expired");
  });

  test("the upload URL carries no credential in a reusable form", needsStorage, async () => {
    const contract = await storage.createUploadUrl({
      key: newKey(),
      contentType: "application/pdf",
      downloadName: "document.pdf",
    });
    const url = new URL(contract.url);

    // A presigned URL necessarily names the access key id; what it must never
    // carry is the secret.
    // A sentinel rather than an empty string: `"".includes("")` is true, so an
    // unset secret would turn this assertion into a guaranteed failure.
    const secret = process.env.S3_SECRET_ACCESS_KEY || "no-secret-configured";
    assert.ok(
      !contract.url.includes(secret),
      "the secret access key appears in the presigned URL",
    );
    assert.ok(url.searchParams.get("X-Amz-Signature"), "no signature on the presigned URL");
    assert.ok(url.searchParams.get("X-Amz-Expires"), "no expiry on the presigned URL");
  });

  test("the signed headers bind the content type", needsStorage, async () => {
    // The property that makes the upload contract meaningful: a client cannot
    // accept the URL and then store something else under it. Without this, a
    // presigned PUT would be a blank cheque for one key.
    const key = newKey();
    const contract = await storage.createUploadUrl({
      key,
      contentType: "application/pdf",
      downloadName: "document.pdf",
    });

    const tampered = await fetch(contract.url, {
      method: "PUT",
      headers: { ...contract.headers, "content-type": "text/html" },
      body: PDF,
    });

    assert.ok(
      !tampered.ok,
      `storing with an altered content-type was accepted (${tampered.status})`,
    );
    assert.equal(await storage.headObject(key), null, "a tampered PUT still stored an object");
  });

  test("the signed headers bind the download disposition", needsStorage, async () => {
    // Content-Disposition is the control that stops a file-typing mistake
    // becoming stored XSS, so the uploader must not be able to drop it.
    const key = newKey();
    const contract = await storage.createUploadUrl({
      key,
      contentType: "application/pdf",
      downloadName: "document.pdf",
    });

    const withoutDisposition = await fetch(contract.url, {
      method: "PUT",
      headers: { "content-type": contract.headers["content-type"]! },
      body: PDF,
    });

    assert.ok(!withoutDisposition.ok, "a PUT that dropped Content-Disposition was accepted");
  });

  test("stored objects are marked as attachments", needsStorage, async () => {
    const key = newKey();
    await put(key, PDF, "quarterly report.pdf");

    const url = await storage.createDownloadUrl({
      key,
      contentType: "application/pdf",
      downloadName: "quarterly report.pdf",
    });
    const response = await fetch(url);

    assert.ok(response.ok, `download failed: ${response.status}`);
    const disposition = response.headers.get("content-disposition") ?? "";
    assert.match(disposition, /^attachment/, `served inline: ${disposition}`);
    assert.match(disposition, /quarterly report\.pdf/);
  });

  test("HEAD reports the authoritative size and type", needsStorage, async () => {
    const key = newKey();
    await put(key, PDF);

    const stored = await storage.headObject(key);
    assert.ok(stored, "HEAD found nothing");
    // The size comes from the store, not from anything a client said.
    assert.equal(stored.sizeBytes, PDF.length);
    assert.equal(stored.contentType, "application/pdf");
    assert.ok(stored.etag, "no etag");
  });

  test("HEAD returns null for an object that does not exist", needsStorage, async () => {
    assert.equal(await storage.headObject(newKey()), null);
  });

  test("a ranged read returns exactly the bytes asked for", needsStorage, async () => {
    const key = newKey();
    await put(key, PDF);

    const head = await storage.readRange(key, 0, 15);
    assert.equal(head.length, 16, "expected sixteen bytes");
    assert.deepEqual(Array.from(head.subarray(0, 4)), [0x25, 0x50, 0x44, 0x46], "not %PDF");
    // The whole object is 18 bytes; a 16-byte read must not have fetched it all.
    assert.ok(head.length < PDF.length);
  });

  test("a ranged read past the end returns what exists", needsStorage, async () => {
    const key = newKey();
    await put(key, PDF.slice(0, 8));
    const head = await storage.readRange(key, 0, 15);
    assert.equal(head.length, 8);
  });

  test("deleting removes the object", needsStorage, async () => {
    const key = newKey();
    await put(key, PDF);
    assert.ok(await storage.headObject(key), "setup failed: nothing stored");

    await storage.deleteObject(key);
    assert.equal(await storage.headObject(key), null, "the object survived deletion");
  });

  test("deleting something absent is not an error", needsStorage, async () => {
    // Confirmation deletes rejected objects on a path that is already failing.
    // If that throw-on-missing, a rejected upload would become a 500.
    await storage.deleteObject(newKey());
  });

  test("a download URL expires", needsStorage, async () => {
    const key = newKey();
    await put(key, PDF);

    const url = await storage.createDownloadUrl({
      key,
      contentType: "application/pdf",
      downloadName: "document.pdf",
      expiresInSeconds: 1,
    });
    assert.ok((await fetch(url)).ok, "the fresh URL did not work");

    await new Promise((resolve) => setTimeout(resolve, 2100));
    const late = await fetch(url);
    assert.ok(!late.ok, `an expired download URL still worked (${late.status})`);
  });

  test("the endpoint answers a browser's CORS preflight", needsStorage, async () => {
    // A direct-to-storage upload is a cross-origin PUT with custom headers, so
    // the browser sends an OPTIONS preflight first. Node does not do that on
    // its own, so this issues the preflight explicitly.
    //
    // This proves the *endpoint* would answer one. It is not a substitute for
    // a real browser upload against the production bucket, where the CORS rule
    // is configuration rather than a default — see the Phase 1.5 notes.
    const contract = await storage.createUploadUrl({
      key: newKey(),
      contentType: "application/pdf",
      downloadName: "document.pdf",
    });

    const preflight = await fetch(contract.url, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3123",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type,content-disposition",
      },
    });

    assert.ok(preflight.status < 400, `preflight refused: ${preflight.status}`);
    assert.ok(
      preflight.headers.get("access-control-allow-origin"),
      "no Access-Control-Allow-Origin on the preflight response",
    );
  });
});
