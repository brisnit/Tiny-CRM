import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { contentSecurityPolicy } from "../../src/lib/csp";

/**
 * The one origin the Content Security Policy opens for uploads.
 *
 * Documents go browser -> object storage directly, so `connect-src 'self'`
 * blocks the upload outright. The policy therefore has to name the storage
 * origin — and that is a relaxation of the control that most directly limits
 * where an injected script could send data, so it is pinned here rather than
 * trusted to stay narrow.
 *
 * What these assert: exactly one origin, never a wildcard, never a path, and
 * nothing at all when storage is not configured.
 */

const directive = (policy: string) =>
  policy.split("; ").find((part) => part.startsWith("connect-src")) ?? "";

const original = { driver: process.env.STORAGE_DRIVER, endpoint: process.env.S3_ENDPOINT };

afterEach(() => {
  if (original.driver === undefined) delete process.env.STORAGE_DRIVER;
  else process.env.STORAGE_DRIVER = original.driver;
  if (original.endpoint === undefined) delete process.env.S3_ENDPOINT;
  else process.env.S3_ENDPOINT = original.endpoint;
});

describe("connect-src and object storage", () => {
  test("stays closed when no storage is configured", () => {
    delete process.env.STORAGE_DRIVER;
    delete process.env.S3_ENDPOINT;
    // The shipped state: this is byte-for-byte the policy that existed before
    // documents were built.
    assert.equal(directive(contentSecurityPolicy("n")), "connect-src 'self'");
  });

  test("stays closed when the driver is explicitly none", () => {
    process.env.STORAGE_DRIVER = "none";
    process.env.S3_ENDPOINT = "https://account.r2.cloudflarestorage.com";
    assert.equal(directive(contentSecurityPolicy("n")), "connect-src 'self'");
  });

  test("names exactly the storage origin when configured", () => {
    process.env.STORAGE_DRIVER = "s3";
    process.env.S3_ENDPOINT = "https://account.r2.cloudflarestorage.com";
    assert.equal(
      directive(contentSecurityPolicy("n")),
      "connect-src 'self' https://account.r2.cloudflarestorage.com",
    );
  });

  test("carries the origin only, never the path or query", () => {
    // A presigned URL's path is the storage key and its query is the signature.
    // Neither belongs in a response header.
    process.env.STORAGE_DRIVER = "s3";
    process.env.S3_ENDPOINT = "https://account.r2.cloudflarestorage.com/bucket/secret?x=1";
    const value = directive(contentSecurityPolicy("n"));
    assert.equal(value, "connect-src 'self' https://account.r2.cloudflarestorage.com");
    assert.ok(!value.includes("bucket"), "the bucket leaked into the policy");
    assert.ok(!value.includes("secret"), "the key leaked into the policy");
  });

  test("never widens to a wildcard", () => {
    for (const endpoint of ["*", "https://*", "not a url", ""]) {
      process.env.STORAGE_DRIVER = "s3";
      process.env.S3_ENDPOINT = endpoint;
      const value = directive(contentSecurityPolicy("n"));
      assert.ok(!value.includes("*"), `a wildcard reached the policy via ${JSON.stringify(endpoint)}`);
    }
  });

  test("a malformed endpoint leaves the policy closed rather than open", () => {
    process.env.STORAGE_DRIVER = "s3";
    process.env.S3_ENDPOINT = "http://[not-a-host";
    assert.equal(directive(contentSecurityPolicy("n")), "connect-src 'self'");
  });

  test("the rest of the policy is untouched by storage configuration", () => {
    process.env.STORAGE_DRIVER = "s3";
    process.env.S3_ENDPOINT = "https://account.r2.cloudflarestorage.com";
    const policy = contentSecurityPolicy("n");

    // The directives that keep user content from executing on our origin.
    for (const expected of ["object-src 'none'", "frame-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
      assert.ok(policy.includes(expected), `${expected} was lost`);
    }
  });
});
