import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * What the driver reports when a provider does not state a length.
 *
 * `headObject` used to return `NaN` for a HEAD response carrying no
 * `content-length`, on the reasoning that a missing length is not something to
 * guess about. The reasoning was right; the consequence was not.
 * `confirmUpload` treats a non-finite size as zero, so a provider that merely
 * declined to state a length had its customer told **"That file is empty"**
 * about a file that was not empty, and the stored object was discarded.
 *
 * That is not hypothetical. A production upload of a 68-byte text file was
 * refused as empty, and this is the only reachable path that produces that
 * outcome for a file which is not empty: the request-time check cannot, because
 * `requestSchema` requires `sizeBytes` to be a positive integer and Zod refuses
 * zero before `validateUpload` ever runs.
 *
 * So the size is measured rather than guessed, and the four cases below are the
 * ones a provider can actually present. The distinction that matters is the
 * last two: *unknown* must not be reported as *zero*, while a genuinely empty
 * object still has to be caught.
 */
const BODY = Buffer.from("A".repeat(68), "latin1");

type Mode = "states-length" | "omits-length" | "omits-and-empty" | "omits-and-ignores-range";
let mode: Mode = "states-length";
let server: Server;
let origin = "";

function respond(method: string, response: ServerResponse): void {
  const head = method === "HEAD";
  switch (mode) {
    case "states-length":
      if (head) {
        response.writeHead(200, { "content-length": String(BODY.length), "content-type": "text/plain" });
        response.end();
        return;
      }
      response.writeHead(206, { "content-range": `bytes 0-0/${BODY.length}`, "content-length": "1" });
      response.end(BODY.subarray(0, 1));
      return;

    case "omits-length":
      if (head) {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end();
        return;
      }
      response.writeHead(206, { "content-range": `bytes 0-0/${BODY.length}`, "content-length": "1" });
      response.end(BODY.subarray(0, 1));
      return;

    case "omits-and-empty":
      if (head) {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end();
        return;
      }
      // A zero-length object cannot satisfy `bytes=0-0`.
      response.writeHead(416).end();
      return;

    case "omits-and-ignores-range":
      if (head) {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end();
        return;
      }
      // Ignoring a range and sending the whole object is legal HTTP.
      response.writeHead(200, { "content-length": String(BODY.length) });
      response.end(BODY);
      return;
  }
}

let storage: import("../../src/lib/storage").StorageDriver;

before(async () => {
  server = createServer((request, response) => respond(request.method ?? "GET", response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  process.env.STORAGE_DRIVER = "s3";
  process.env.STORAGE_BUCKET = "head-size-bucket";
  process.env.S3_ENDPOINT = origin;
  process.env.S3_REGION = "auto";
  process.env.S3_ACCESS_KEY_ID = "test-access-key";
  process.env.S3_SECRET_ACCESS_KEY = "test-secret-key";

  const { getStorage } = await import("../../src/lib/storage");
  storage = getStorage();
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** The condition `confirmUpload` applies, so the test asserts the real consequence. */
function wouldBeRefusedAsEmpty(size: number | undefined): boolean {
  return size === undefined || !Number.isFinite(size) || size <= 0;
}

describe("the size of a stored object", () => {
  test("a provider that states content-length is believed", async () => {
    mode = "states-length";
    const stored = await storage.headObject("workspaces/w/probe.txt");
    assert.equal(stored?.sizeBytes, 68);
    assert.equal(wouldBeRefusedAsEmpty(stored?.sizeBytes), false);
  });

  test("a provider that omits it is asked, not guessed about", async () => {
    mode = "omits-length";
    const stored = await storage.headObject("workspaces/w/probe.txt");
    // 68, from the provider's own Content-Range total. Before this it was NaN,
    // and a 68-byte file was refused with "That file is empty."
    assert.equal(stored?.sizeBytes, 68, "a stated range total was not used as the size");
    assert.equal(
      wouldBeRefusedAsEmpty(stored?.sizeBytes),
      false,
      "an object of known size would still be refused as empty",
    );
  });

  test("an object that really is empty is still reported as empty", async () => {
    // The direction that keeps the check a control rather than a formality: the
    // fallback must not turn every unmeasurable object into a plausible size.
    mode = "omits-and-empty";
    const stored = await storage.headObject("workspaces/w/probe.txt");
    assert.equal(stored?.sizeBytes, 0);
    assert.equal(wouldBeRefusedAsEmpty(stored?.sizeBytes), true);
  });

  test("a provider that ignores the range is measured by what arrived", async () => {
    mode = "omits-and-ignores-range";
    const stored = await storage.headObject("workspaces/w/probe.txt");
    assert.equal(stored?.sizeBytes, 68);
    assert.equal(wouldBeRefusedAsEmpty(stored?.sizeBytes), false);
  });
});
