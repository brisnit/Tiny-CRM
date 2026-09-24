import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createServer as createRawServer, type Server as RawServer, type AddressInfo } from "node:net";

/**
 * `readObject`, and the two ceilings that keep it from being a memory bug.
 *
 * Document ingestion is the one path that buffers a whole stored object, so the
 * ceiling is the only thing between a hostile or broken object and the heap of
 * a shared function. It is enforced twice:
 *
 *   1. against `Content-Length`, before the body is touched;
 *   2. against the bytes actually received, while the stream is consumed.
 *
 * The second is the one that is load-bearing, and it is the one a real S3
 * server cannot be made to exercise — you cannot ask MinIO or R2 to understate
 * a length or to omit it. So this suite stands up an HTTP server that does
 * exactly that. The driver is pointed at it and signs its requests normally;
 * what is under test is how it treats the response.
 *
 * `tests/integration/storage.test.ts` covers the honest case against a real
 * endpoint. This covers the dishonest one.
 */

const BUCKET = "readobject-test";

type Behaviour =
  | { kind: "honest"; bytes: Buffer }
  | { kind: "no-length"; bytes: Buffer }
  | { kind: "missing" }
  | { kind: "error"; status: number };

let server: Server;
let origin: string;
let behaviour: Behaviour = { kind: "missing" };

// Imported dynamically, after the environment is set: src/lib/env.ts reads
// process.env once, when it is first imported.
let storage: import("../../src/lib/storage").StorageDriver;
let StorageObjectTooLarge: typeof import("../../src/lib/storage").StorageObjectTooLarge;
let StorageObjectMissing: typeof import("../../src/lib/storage").StorageObjectMissing;

before(async () => {
  server = createServer((request, response) => {
    if (behaviour.kind === "missing") {
      response.writeHead(404).end();
      return;
    }
    if (behaviour.kind === "error") {
      response.writeHead(behaviour.status).end("upstream said no");
      return;
    }

    const { bytes } = behaviour;
    if (behaviour.kind === "honest") {
      response.writeHead(200, { "content-length": String(bytes.length) });
      response.end(bytes);
      return;
    }
    // No content-length at all: chunked, which is legal and common.
    response.writeHead(200, { "transfer-encoding": "chunked" });
    response.end(bytes);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;

  process.env.STORAGE_DRIVER = "s3";
  process.env.STORAGE_BUCKET = BUCKET;
  process.env.S3_ENDPOINT = origin;
  process.env.S3_ACCESS_KEY_ID = "test-access-key";
  process.env.S3_SECRET_ACCESS_KEY = "test-secret-key";

  const storageModule = await import("../../src/lib/storage");
  storageModule.resetStorageForTests();
  storage = storageModule.getStorage();
  StorageObjectTooLarge = storageModule.StorageObjectTooLarge;
  StorageObjectMissing = storageModule.StorageObjectMissing;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const KEY = "workspaces/ws_test/document.pdf";

describe("readObject", () => {
  test("returns the object when it fits", async () => {
    const bytes = Buffer.from("%PDF-1.7\nsmall but real");
    behaviour = { kind: "honest", bytes };

    const read = await storage.readObject(KEY, 1024);
    assert.equal(Buffer.from(read).toString(), bytes.toString());
  });

  test("rejects on Content-Length, before reading the body", async () => {
    behaviour = { kind: "honest", bytes: Buffer.alloc(5_000, 0x41) };

    await assert.rejects(
      () => storage.readObject(KEY, 1_000),
      (error: unknown) => {
        assert.ok(error instanceof StorageObjectTooLarge, `threw ${String(error)}`);
        assert.equal(error.maxBytes, 1_000);
        assert.equal(error.sizeBytes, 5_000);
        return true;
      },
    );
  });

  test("still rejects when Content-Length is absent", async () => {
    // The check that actually bounds the allocation. Without it, a chunked
    // response of any size would be buffered in full.
    behaviour = { kind: "no-length", bytes: Buffer.alloc(5_000, 0x42) };

    await assert.rejects(
      () => storage.readObject(KEY, 1_000),
      (error: unknown) => {
        assert.ok(error instanceof StorageObjectTooLarge, `threw ${String(error)}`);
        // Discovered from the stream, so the size is what had arrived when the
        // ceiling was crossed rather than the object's true length.
        assert.ok(error.sizeBytes > 1_000, "the overrun was not detected from the body");
        return true;
      },
    );
  });

  test("still rejects when Content-Length understates the body", async () => {
    /**
     * The adversarial case: a header small enough to pass check one, attached
     * to a body large enough to matter. Only the streaming check catches it.
     *
     * This needs a raw TCP server. Node's own HTTP server will not emit a
     * response whose body disagrees with its `Content-Length` — it truncates to
     * the declared length — so the first attempt at this test could not produce
     * the condition it was asserting, and passed by reading ten honest bytes.
     * The response below is written onto the socket by hand.
     */
    const raw: RawServer = createRawServer((socket) => {
      const body = Buffer.alloc(8_000, 0x43);
      socket.write(
        "HTTP/1.1 200 OK\r\n" +
          "Content-Type: application/pdf\r\n" +
          "Content-Length: 10\r\n" +
          "Connection: close\r\n\r\n",
      );
      socket.write(body);
      socket.end();
    });
    await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", resolve));
    const { port } = raw.address() as AddressInfo;

    process.env.S3_ENDPOINT = `http://127.0.0.1:${port}`;
    const storageModule = await import("../../src/lib/storage");
    storageModule.resetStorageForTests();

    try {
      await assert.rejects(
        () => storageModule.getStorage().readObject(KEY, 1_000),
        (error: unknown) => {
          assert.ok(
            error instanceof storageModule.StorageObjectTooLarge,
            `an understated Content-Length bypassed the ceiling: ${String(error)}`,
          );
          return true;
        },
      );
    } finally {
      process.env.S3_ENDPOINT = origin;
      storageModule.resetStorageForTests();
      await new Promise<void>((resolve) => raw.close(() => resolve()));
    }
  });

  test("an object exactly at the ceiling is allowed", async () => {
    behaviour = { kind: "honest", bytes: Buffer.alloc(1_000, 0x44) };
    const read = await storage.readObject(KEY, 1_000);
    assert.equal(read.byteLength, 1_000);
  });

  test("a missing object is distinguishable from an outage", async () => {
    behaviour = { kind: "missing" };
    await assert.rejects(() => storage.readObject(KEY, 1_000), StorageObjectMissing);
  });

  test("a provider error does not become a success", async () => {
    behaviour = { kind: "error", status: 503 };
    await assert.rejects(() => storage.readObject(KEY, 1_000));
  });

  test("a nonsensical ceiling is refused rather than interpreted", async () => {
    behaviour = { kind: "honest", bytes: Buffer.from("%PDF-1.7") };
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await assert.rejects(
        () => storage.readObject(KEY, bad),
        `a ceiling of ${bad} was accepted`,
      );
    }
  });

  test("no credential appears in the request URL", async () => {
    // SigV4 here signs headers, not the query string: nothing credential-bearing
    // should be constructible from what a proxy or log would see.
    let seenUrl = "";
    const capture = createServer((request, response) => {
      seenUrl = request.url ?? "";
      response.writeHead(200, { "content-length": "8" }).end("%PDF-1.7");
    });
    await new Promise<void>((resolve) => capture.listen(0, "127.0.0.1", resolve));
    const { port } = capture.address() as AddressInfo;

    process.env.S3_ENDPOINT = `http://127.0.0.1:${port}`;
    const storageModule = await import("../../src/lib/storage");
    storageModule.resetStorageForTests();
    await storageModule.getStorage().readObject(KEY, 1_000);

    assert.ok(!/X-Amz-Signature/i.test(seenUrl), `the URL carried a signature: ${seenUrl}`);
    assert.ok(!/test-secret-key/.test(seenUrl), "the URL carried the secret key");
    assert.ok(!/X-Amz-Credential/i.test(seenUrl), `the URL carried a credential: ${seenUrl}`);

    await new Promise<void>((resolve) => capture.close(() => resolve()));
    process.env.S3_ENDPOINT = origin;
    storageModule.resetStorageForTests();
  });
});
