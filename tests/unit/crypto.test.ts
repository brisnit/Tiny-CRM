import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  SecretUnreadableError,
} from "../../src/lib/crypto";

/**
 * Authenticated encryption for stored OAuth tokens.
 *
 * The schema has claimed since the integration models were added that
 * `Integration.credentials` is "Encrypted at rest by src/lib/crypto.ts", and
 * the Settings screen repeated it to customers. There was no such module. These
 * are the properties that make the claim true rather than aspirational.
 */
describe("stored secrets are encrypted, authenticated and purpose-bound", () => {
  test("a secret round-trips", () => {
    const token = JSON.stringify({ access: "ya29." + "x".repeat(120), refresh: "1//abc" });
    const sealed = encryptSecret(token, "integration-credentials");
    assert.notEqual(sealed, token, "the value was stored in clear");
    assert.ok(!sealed.includes("ya29."), "the plaintext is recoverable from the envelope");
    assert.equal(decryptSecret(sealed, "integration-credentials"), token);
  });

  test("the same input encrypts differently every time", () => {
    // A fixed IV would make identical tokens identical ciphertexts, which leaks
    // that two connections hold the same credential.
    const a = encryptSecret("same", "integration-credentials");
    const b = encryptSecret("same", "integration-credentials");
    assert.notEqual(a, b, "the IV is not random per message");
    assert.equal(decryptSecret(a, "integration-credentials"), "same");
    assert.equal(decryptSecret(b, "integration-credentials"), "same");
  });

  test("a tampered ciphertext is refused rather than returning plausible bytes", () => {
    const sealed = encryptSecret("secret-value", "integration-credentials");
    const parts = sealed.split(".");
    // Flip a byte in the ciphertext. GCM's auth tag is what makes this fail
    // loudly instead of decrypting to garbage a caller might use.
    const data = Buffer.from(parts[4]!, "base64url");
    data[0] ^= 0xff;
    const tampered = [parts[0], parts[1], parts[2], parts[3], data.toString("base64url")].join(".");
    assert.throws(
      () => decryptSecret(tampered, "integration-credentials"),
      SecretUnreadableError,
      "a tampered ciphertext was accepted",
    );
  });

  test("a tampered auth tag is refused too", () => {
    const sealed = encryptSecret("secret-value", "integration-credentials");
    const parts = sealed.split(".");
    const tag = Buffer.from(parts[3]!, "base64url");
    tag[0] ^= 0xff;
    const tampered = [parts[0], parts[1], parts[2], tag.toString("base64url"), parts[4]].join(".");
    assert.throws(() => decryptSecret(tampered, "integration-credentials"), SecretUnreadableError);
  });

  test("malformed and truncated envelopes fail as unreadable, not as a crash", () => {
    for (const bad of ["", "v1", "v1.integration-credentials", "not-even-close", "v2.a.b.c.d"]) {
      assert.throws(
        () => decryptSecret(bad, "integration-credentials"),
        SecretUnreadableError,
        `"${bad}" did not fail as unreadable`,
      );
    }
  });

  test("the failure never quotes the stored bytes", () => {
    // The message reaches logs and, through AppError, a user-facing string.
    const sealed = encryptSecret("super-secret-token", "integration-credentials");
    try {
      decryptSecret(sealed.slice(0, sealed.length - 8), "integration-credentials");
      assert.fail("expected a failure");
    } catch (error) {
      assert.ok(error instanceof SecretUnreadableError);
      const rendered = `${error.message} ${String(error.internal ?? "")}`;
      assert.ok(!rendered.includes("super-secret"), "the error quoted the plaintext");
      assert.ok(!rendered.includes(sealed.slice(10, 40)), "the error quoted the ciphertext");
      // And what a customer sees is actionable.
      assert.match(error.message, /reconnect/i);
    }
  });

  test("a ciphertext written for one purpose is not readable under another", () => {
    // There is one purpose today, so this exercises the guard by relabelling an
    // envelope — which is also the realistic shape of the bug it prevents: a
    // value moved or copied between two columns with different purposes, where
    // silently decrypting under the wrong key would be a confused deputy.
    const sealed = encryptSecret("tok", "integration-credentials");
    const relabelled = sealed.replace("integration-credentials", "some-other-purpose");
    assert.notEqual(relabelled, sealed, "the purpose is not recorded in the envelope");
    assert.throws(
      () => decryptSecret(relabelled, "integration-credentials"),
      (error: unknown) =>
        error instanceof SecretUnreadableError &&
        /is for some-other-purpose, not integration-credentials/.test(String(error.internal)),
      "a relabelled envelope was accepted",
    );
  });

  test("isEncrypted recognises this module's output and nothing else", () => {
    assert.equal(isEncrypted(encryptSecret("x", "integration-credentials")), true);
    for (const value of [null, undefined, "", "plaintext", "v1.a.b.c"]) {
      assert.equal(isEncrypted(value as string), false, `misidentified ${String(value)}`);
    }
  });
});
