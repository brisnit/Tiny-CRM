import "server-only";

import { AwsClient } from "aws4fetch";

import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/logger";

/**
 * Object storage.
 *
 * The file that `prisma/schema.prisma` has referred to since the FileAsset model
 * was written, and which did not exist until now.
 *
 * ---------------------------------------------------------------------------
 * What this module is for
 * ---------------------------------------------------------------------------
 *
 * Exactly five capabilities, because five is what the upload and download paths
 * need and anything more is a provider feature leaking into the application:
 *
 *   createUploadUrl    a time-limited URL the browser may PUT one object to
 *   createDownloadUrl  a time-limited URL the browser may GET one object from
 *   headObject         authoritative size and type of a stored object
 *   readRange          a few bytes from the front of an object
 *   readObject         the whole object, server-side, under a hard ceiling
 *   deleteObject       removal
 *
 * Nothing here returns a provider SDK object, a bucket handle, or a raw
 * response. The application asks for a URL or a fact and gets a URL or a fact.
 *
 * ---------------------------------------------------------------------------
 * Why the bytes never come through here
 * ---------------------------------------------------------------------------
 *
 * `createUploadUrl` and `createDownloadUrl` return URLs *for the browser to
 * use*. The file itself travels browser <-> object storage and never passes
 * through a Server Action or a Route Handler. That is a deliberate constraint
 * and not only a performance one: Vercel caps a function's request body at a
 * few megabytes, well under the 25 MB this product accepts, so a proxying
 * design would fail on exactly the files people most want to store.
 *
 * `readRange` is one exception, and it is bounded to the first sixteen bytes of
 * an object. Sixteen bytes is metadata, not a file — see the magic byte
 * discussion in `src/lib/actions/files.ts`.
 *
 * `readObject` is the other, and it is a different kind of exception: it really
 * does buffer a whole document. It exists for Document Intelligence, which has
 * to hand complete bytes to a PDF parser, and it is deliberately **not** the
 * browser path — nothing it returns is ever sent to a client. The constraint
 * that made the upload path avoid proxying is a request-body limit on the way
 * *in*; reading an object we already own, into a background job, under an
 * explicit ceiling, is not the same operation.
 *
 * The alternative considered and rejected was for the server to fetch its own
 * presigned URL. That works, and it was proven working during the Phase 3B
 * spike — but it sends a credential-bearing URL out through the public edge to
 * read bytes we already hold keys for, and it puts a signed URL into a variable
 * in the ingestion path. A private signed GET is strictly less exposure.
 *
 * ---------------------------------------------------------------------------
 * Why there is one driver and not two
 * ---------------------------------------------------------------------------
 *
 * `STORAGE_DRIVER=local` and `STORAGE_DRIVER=s3` select the *same* code. Local
 * development points it at MinIO; production points it at Cloudflare R2. Both
 * speak the S3 API, so a developer exercises real SigV4 signing, real presigned
 * URLs, real CORS preflights, real ranged GETs and real deletes.
 *
 * A filesystem driver was considered and rejected. It would have been a second
 * implementation to keep correct, and it would have proven the one thing least
 * worth proving — that a function can write a file — while silently skipping
 * every part of the production path that can actually be wrong.
 *
 * Addressing is path-style (`<endpoint>/<bucket>/<key>`) because that is what
 * MinIO wants by default and what R2 accepts, so one code path serves both.
 */

export type UploadContract = {
  /** Always PUT. The browser does not choose a verb. */
  method: "PUT";
  url: string;
  /**
   * Headers the browser MUST send. They are part of the signature, so a client
   * that alters or omits one gets a signature failure from the storage provider
   * rather than a stored object with attacker-chosen metadata.
   */
  headers: Record<string, string>;
  expiresAt: string;
};

export type StoredObject = {
  sizeBytes: number;
  contentType: string | null;
  etag: string | null;
};

export type CreateUploadInput = {
  key: string;
  /** The type the *server* determined from the extension, never the browser's claim. */
  contentType: string;
  /** Display name used to build Content-Disposition. Already sanitised. */
  downloadName: string;
  expiresInSeconds?: number;
};

export type CreateDownloadInput = {
  key: string;
  contentType: string;
  downloadName: string;
  expiresInSeconds?: number;
};

export interface StorageDriver {
  readonly kind: "none" | "s3";
  createUploadUrl(input: CreateUploadInput): Promise<UploadContract>;
  createDownloadUrl(input: CreateDownloadInput): Promise<string>;
  /** Null when the object does not exist. Anything else throws. */
  headObject(key: string): Promise<StoredObject | null>;
  /** Inclusive byte range. Returns fewer bytes than asked when the object is shorter. */
  readRange(key: string, start: number, endInclusive: number): Promise<Uint8Array>;
  /**
   * The whole object, server-side, bounded.
   *
   * Throws `StorageObjectTooLarge` rather than returning a truncated buffer: a
   * half-read PDF is not a smaller PDF, and silently handing one to a parser
   * produces a confident wrong answer instead of an error.
   */
  readObject(key: string, maxBytes: number): Promise<Uint8Array>;
  /** Idempotent: deleting an absent object is not an error. */
  deleteObject(key: string): Promise<void>;
}

/** Default lifetime of a presigned URL. Short: it is used immediately or not at all. */
const DEFAULT_UPLOAD_TTL_SECONDS = 10 * 60;
const DEFAULT_DOWNLOAD_TTL_SECONDS = 60;

/**
 * Forces every stored object to be handed to the browser as a download.
 *
 * This is the control that stops a file-typing mistake becoming stored XSS. It
 * is applied at upload time, as object metadata, and it is *signed* — so it
 * describes what the server decided rather than what the uploader asked for.
 * `src/lib/uploads.ts` builds the same header for the day something is served
 * from our own origin; this is the same rule applied at the other end.
 */
function contentDispositionFor(downloadName: string): string {
  // The quote strip mirrors downloadHeaders() in src/lib/uploads.ts. The name
  // has already been through sanitizeFilename, so this is the second guard on a
  // value that is a display label and never a path.
  return `attachment; filename="${downloadName.replace(/"/g, "")}"`;
}

/**
 * The driver used when no object storage is configured.
 *
 * It throws rather than returning a falsy value, because a silent no-op here
 * would let an upload path appear to work while storing nothing. `STORAGE_DRIVER`
 * is unset in this build, so this is the shipped behaviour.
 */
class UnconfiguredStorage implements StorageDriver {
  readonly kind = "none" as const;

  private refuse(): never {
    throw new AppError("internal", "File storage is not available.", {
      internal:
        "No object storage is configured. Set STORAGE_DRIVER, STORAGE_BUCKET, " +
        "S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.",
    });
  }

  async createUploadUrl(): Promise<UploadContract> { this.refuse(); }
  async createDownloadUrl(): Promise<string> { this.refuse(); }
  async headObject(): Promise<StoredObject | null> { this.refuse(); }
  async readRange(): Promise<Uint8Array> { this.refuse(); }
  /**
   * Refuses, like every other capability here.
   *
   * Considered and rejected: returning an empty buffer so that ingestion could
   * "work" with no storage configured. An empty buffer is not a zero-page PDF,
   * it is a lie — extraction would fail on it and the document would be marked
   * unreadable, blaming the customer's file for a missing environment variable.
   * Refusing produces `storage_unavailable`, which is what actually happened.
   */
  async readObject(): Promise<Uint8Array> { this.refuse(); }
  async deleteObject(): Promise<void> { this.refuse(); }
}

/**
 * The object was bigger than the caller was willing to read.
 *
 * A distinct type rather than a generic failure because the ingestion path has
 * to tell these apart: too large is a fact about the document that a person can
 * be told, and a storage outage is a fact about us that they cannot act on.
 *
 * Carries sizes for the log, and no key, bucket or endpoint in its message.
 */
export class StorageObjectTooLarge extends Error {
  constructor(
    readonly key: string,
    readonly sizeBytes: number,
    readonly maxBytes: number,
  ) {
    super(`Stored object exceeds the ${maxBytes} byte ceiling`);
    this.name = "StorageObjectTooLarge";
  }
}

/** The object is not there. Distinguished for the same reason as above. */
export class StorageObjectMissing extends Error {
  constructor(readonly key: string) {
    super("Stored object does not exist");
    this.name = "StorageObjectMissing";
  }
}

type S3Config = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

class S3Storage implements StorageDriver {
  readonly kind = "s3" as const;
  private readonly client: AwsClient;

  constructor(private readonly config: S3Config) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region,
      service: "s3",
    });
  }

  /**
   * Path-style object URL.
   *
   * Each key segment is encoded separately so that the slashes which make the
   * `workspaces/<id>/<uuid>.<ext>` hierarchy survive, while anything unusual
   * inside a segment does not change the path. Keys are server-generated, so
   * this is defence in depth rather than the primary control.
   */
  private objectUrl(key: string): URL {
    const encoded = key.split("/").map(encodeURIComponent).join("/");
    return new URL(`${this.config.endpoint}/${this.config.bucket}/${encoded}`);
  }

  async createUploadUrl(input: CreateUploadInput): Promise<UploadContract> {
    const ttl = input.expiresInSeconds ?? DEFAULT_UPLOAD_TTL_SECONDS;
    const url = this.objectUrl(input.key);
    url.searchParams.set("X-Amz-Expires", String(ttl));

    const disposition = contentDispositionFor(input.downloadName);
    // Both headers are signed, so the browser must send them verbatim. This is
    // what makes the stored object's type and disposition the server's decision.
    const headers = {
      "content-type": input.contentType,
      "content-disposition": disposition,
    };

    const signed = await this.client.sign(url.toString(), {
      method: "PUT",
      headers,
      aws: { signQuery: true, allHeaders: true },
    });

    return {
      method: "PUT",
      url: signed.url,
      headers,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  async createDownloadUrl(input: CreateDownloadInput): Promise<string> {
    const ttl = input.expiresInSeconds ?? DEFAULT_DOWNLOAD_TTL_SECONDS;
    const url = this.objectUrl(input.key);
    url.searchParams.set("X-Amz-Expires", String(ttl));
    // The object already carries Content-Disposition from upload. Asking for it
    // again on the response is belt and braces: it covers an object stored
    // before that rule existed, and costs one query parameter.
    url.searchParams.set("response-content-disposition", contentDispositionFor(input.downloadName));
    url.searchParams.set("response-content-type", input.contentType);

    const signed = await this.client.sign(url.toString(), {
      method: "GET",
      aws: { signQuery: true },
    });
    return signed.url;
  }

  async headObject(key: string): Promise<StoredObject | null> {
    const response = await this.client.fetch(this.objectUrl(key).toString(), { method: "HEAD" });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw await this.failure("HEAD", key, response);
    }

    const length = response.headers.get("content-length");
    return {
      // An object with no content-length is not something to guess about.
      sizeBytes: length === null ? Number.NaN : Number(length),
      contentType: response.headers.get("content-type"),
      etag: response.headers.get("etag"),
    };
  }

  async readRange(key: string, start: number, endInclusive: number): Promise<Uint8Array> {
    const response = await this.client.fetch(this.objectUrl(key).toString(), {
      method: "GET",
      headers: { range: `bytes=${start}-${endInclusive}` },
    });

    // 206 is the expected answer. 200 means the provider ignored the range and
    // sent the whole object, which is legal HTTP and which we must not treat as
    // licence to buffer an arbitrary file: the slice below bounds it either way.
    if (!response.ok) {
      throw await this.failure("GET range", key, response);
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    const wanted = endInclusive - start + 1;
    return buffer.length > wanted ? buffer.subarray(0, wanted) : buffer;
  }

  /**
   * The whole object, read privately, under a hard ceiling.
   *
   * Signed with the Authorization header rather than a query string, so no
   * credential-bearing URL is ever produced, logged, or capable of being passed
   * to anything else. The bytes travel from the provider into this process and
   * stop here.
   *
   * The ceiling is enforced **twice**, because one of the checks can be lied to:
   *
   *  1. `Content-Length`, before the body is touched. This is the cheap check
   *     and the one that matters operationally — an oversized object costs one
   *     round trip and no memory.
   *
   *  2. While consuming the stream, against the bytes actually received. A
   *     response may carry no `Content-Length` at all (chunked encoding), or an
   *     understated one. Trusting a header to bound an allocation is how a
   *     memory-exhaustion bug is written, and the first check alone is exactly
   *     that. The second one is the one that is actually load-bearing; the
   *     first is an optimisation over it.
   *
   * Both throw `StorageObjectTooLarge` rather than truncating. A parser handed
   * the first N bytes of a PDF does not report a smaller document, it reports a
   * damaged one — and we would have damaged it.
   */
  async readObject(key: string, maxBytes: number): Promise<Uint8Array> {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new AppError("internal", "File storage is not available right now.", {
        internal: `readObject called with a nonsensical ceiling: ${maxBytes}`,
      });
    }

    const response = await this.client.fetch(this.objectUrl(key).toString(), { method: "GET" });

    if (response.status === 404) {
      throw new StorageObjectMissing(key);
    }
    if (!response.ok) {
      throw await this.failure("GET", key, response);
    }

    // (1) Declared size, before a byte of the body is read.
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const size = Number(declared);
      if (Number.isFinite(size) && size > maxBytes) {
        // The body is abandoned deliberately: there is no reason to receive it.
        await response.body?.cancel().catch(() => {});
        throw new StorageObjectTooLarge(key, size, maxBytes);
      }
    }

    if (!response.body) {
      // A 200 with no body is not an empty document; it is a response we do not
      // understand, and guessing which would be worse than saying so.
      throw new AppError("internal", "File storage is not available right now.", {
        internal: `GET ${key} returned ${response.status} with no body`,
      });
    }

    // (2) Received size, which is the check that cannot be talked out of.
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new StorageObjectTooLarge(key, received, maxBytes);
        }
        parts.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes;
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.client.fetch(this.objectUrl(key).toString(), { method: "DELETE" });
    // S3 returns 204 for a successful delete and for deleting nothing. 404 is
    // also acceptable: the goal state is "absent", and it is absent.
    if (!response.ok && response.status !== 404) {
      throw await this.failure("DELETE", key, response);
    }
  }

  /**
   * Turns a provider response into an internal error.
   *
   * The provider's body is read into the *internal* field only. It can name
   * buckets, endpoints and request ids, none of which belongs in a message a
   * browser will render.
   */
  private async failure(operation: string, key: string, response: Response): Promise<AppError> {
    let body = "";
    try {
      body = (await response.text()).slice(0, 500);
    } catch {
      // A body we cannot read is not worth failing differently over.
    }
    log.error("object storage request failed", {
      operation,
      status: response.status,
      // The key names a workspace, so it is logged rather than returned.
      key,
    });
    return new AppError("internal", "File storage is not available right now.", {
      internal: `${operation} ${key} failed: ${response.status} ${body}`,
    });
  }
}

let cached: StorageDriver | undefined;

/**
 * The configured driver.
 *
 * Memoised because `AwsClient` derives a signing key on construction and the
 * configuration cannot change within a process.
 */
export function getStorage(): StorageDriver {
  if (cached) return cached;
  cached = buildStorage();
  return cached;
}

function buildStorage(): StorageDriver {
  if (env.storageDriver === "none") return new UnconfiguredStorage();

  const { storageEndpoint, storageBucket, storageAccessKeyId, storageSecretAccessKey } = env;
  // `assertProductionEnv` catches this at boot in production. Here it protects
  // development and tests, where that assertion does not run.
  if (!storageEndpoint || !storageBucket || !storageAccessKeyId || !storageSecretAccessKey) {
    return new UnconfiguredStorage();
  }

  return new S3Storage({
    endpoint: storageEndpoint.replace(/\/+$/, ""),
    bucket: storageBucket,
    region: env.storageRegion,
    accessKeyId: storageAccessKeyId,
    secretAccessKey: storageSecretAccessKey,
  });
}

/** Test seam: forces the next `getStorage()` to rebuild from the environment. */
export function resetStorageForTests(): void {
  cached = undefined;
}

export { contentDispositionFor };
