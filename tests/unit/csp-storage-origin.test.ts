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

/**
 * The properties a security review asked to see proven rather than described.
 *
 * All of these concern one question: can anything other than deliberate server
 * configuration widen `connect-src`? The answer has to be no, because that
 * directive is what limits where an injected script may send data.
 */
describe("what cannot widen connect-src", () => {
  const configured = (endpoint: string) => {
    process.env.STORAGE_DRIVER = "s3";
    process.env.S3_ENDPOINT = endpoint;
    return directive(contentSecurityPolicy("n"));
  };

  test("credentials in the endpoint never reach the policy", () => {
    // An operator pasting a URL with userinfo must not publish it in a header
    // sent to every browser.
    const value = configured("https://AKIAEXAMPLE:s3cr3t@account.r2.cloudflarestorage.com");
    assert.equal(value, "connect-src 'self' https://account.r2.cloudflarestorage.com");
    assert.ok(!value.includes("s3cr3t"), "a secret reached the policy");
    assert.ok(!value.includes("AKIA"), "an access key reached the policy");
    assert.ok(!value.includes("@"), "userinfo reached the policy");
  });

  test("a fragment cannot reach the policy", () => {
    assert.equal(
      configured("https://account.r2.cloudflarestorage.com/bucket?sig=abc#frag"),
      "connect-src 'self' https://account.r2.cloudflarestorage.com",
    );
  });

  test("only http and https are accepted", () => {
    for (const endpoint of [
      "file:///etc/passwd",
      "ftp://host.example.com",
      "ws://host.example.com",
      "javascript:alert(1)",
      "data:text/plain,x",
    ]) {
      assert.equal(
        configured(endpoint),
        "connect-src 'self'",
        `${endpoint} was accepted into the policy`,
      );
    }
  });

  test("a wildcard host is refused in every shape", () => {
    for (const endpoint of [
      "https://*",
      "https://*.r2.cloudflarestorage.com",
      "https://*.example.com:443",
      "http://*",
    ]) {
      const value = configured(endpoint);
      assert.equal(value, "connect-src 'self'", `${endpoint} widened the policy`);
    }
  });

  test("configuring R2 adds that one host, not its wildcard", () => {
    const value = configured("https://30b1cb46.r2.cloudflarestorage.com");
    assert.equal(value, "connect-src 'self' https://30b1cb46.r2.cloudflarestorage.com");
    // The distinction the review asked about: one account's endpoint, not every
    // account's.
    assert.ok(!value.includes("*"), "a wildcard was emitted");
    assert.ok(
      !/\s\.r2\.cloudflarestorage\.com/.test(value),
      "a bare suffix was emitted, which would match any account",
    );
  });

  test("a port is kept, because the origin is not the same without it", () => {
    // Local development points at MinIO on a port; dropping it would name a
    // different origin than the one uploads actually use.
    assert.equal(
      configured("http://127.0.0.1:9010"),
      "connect-src 'self' http://127.0.0.1:9010",
    );
  });

  test("an unconfigured policy is exactly the one that shipped", () => {
    // A full-string pin, not just the one directive: if any other directive is
    // ever weakened alongside a storage change, this fails.
    delete process.env.STORAGE_DRIVER;
    delete process.env.S3_ENDPOINT;

    const expected =
      "default-src 'self'; " +
      "script-src 'nonce-NONCE' 'strict-dynamic' 'self'" +
      (process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval' 'unsafe-inline'") + "; " +
      "style-src 'self' 'unsafe-inline'; style-src-elem 'self' 'unsafe-inline'; " +
      "style-src-attr 'unsafe-inline'; " +
      "img-src 'self' data: blob: https://avatars.githubusercontent.com https://lh3.googleusercontent.com; " +
      "font-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; " +
      "frame-src 'none'; object-src 'none'; media-src 'none'; base-uri 'none'; " +
      "worker-src 'self' blob:; manifest-src 'self'" +
      (process.env.NODE_ENV === "production" ? "; upgrade-insecure-requests" : "");

    assert.equal(contentSecurityPolicy("NONCE"), expected);
  });
});
