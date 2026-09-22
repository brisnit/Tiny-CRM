import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { issueUploadToken, readUploadToken, type UploadTokenPayload } from "../../src/lib/upload-token";

/**
 * The upload token.
 *
 * A direct-to-storage upload has a gap in the middle: the server authorises,
 * the browser uploads, the browser comes back. This token is what the server
 * hands itself across that gap, and these tests pin the property the whole
 * two-phase design rests on — **the client cannot change what was decided.**
 *
 * No database and no network: this is signing and nothing else.
 */

const payload = (over: Partial<UploadTokenPayload> = {}): UploadTokenPayload => ({
  key: "workspaces/ws_abc/11111111-2222-3333-4444-555555555555.pdf",
  workspaceId: "ws_abc",
  projectId: "prj_1",
  mimeType: "application/pdf",
  extension: "pdf",
  displayName: "q3-proposal.pdf",
  expiresAt: Date.now() + 60_000,
  ...over,
});

describe("the upload token", () => {
  test("round-trips every decision the server made", () => {
    const original = payload();
    const read = readUploadToken(issueUploadToken(original));
    assert.deepEqual(read, original);
  });

  test("is opaque: the storage key is not readable without decoding", () => {
    // Not a confidentiality claim — it is base64, not encryption. The point is
    // that a browser is handed one string with no structure inviting it to
    // build a different one.
    const token = issueUploadToken(payload());
    assert.ok(!token.includes("workspaces/"), "the raw key appears verbatim in the token");
    assert.equal(token.split(".").length, 2, "expected body.signature");
  });

  test("refuses a token whose payload was edited", () => {
    const token = issueUploadToken(payload());
    const [, signature] = token.split(".") as [string, string];

    // Re-point the upload at another workspace's storage, keeping the signature.
    const forged = Buffer.from(
      JSON.stringify(payload({ workspaceId: "ws_victim", key: "workspaces/ws_victim/secret.pdf" })),
      "utf8",
    ).toString("base64url");

    assert.throws(
      () => readUploadToken(`${forged}.${signature}`),
      /no longer valid/,
      "a payload swap was accepted",
    );
  });

  test("refuses a token signed with a different key", () => {
    // A signature computed over the right body with the wrong secret. The
    // shape is valid; only the key is wrong.
    const token = issueUploadToken(payload());
    const [body] = token.split(".") as [string];
    const wrong = Buffer.from("not-the-real-signature").toString("base64url");
    assert.throws(() => readUploadToken(`${body}.${wrong}`), /no longer valid/);
  });

  test("refuses an expired token", () => {
    const token = issueUploadToken(payload({ expiresAt: Date.now() - 1 }));
    assert.throws(() => readUploadToken(token), /no longer valid/);
  });

  test("refuses a key that escapes the workspace it names", () => {
    // The invariant the design rests on: a token's key must live under its own
    // workspace prefix. This can only fail through an internal inconsistency,
    // which is exactly why it is asserted rather than assumed.
    const token = issueUploadToken(
      payload({ workspaceId: "ws_abc", key: "workspaces/ws_other/file.pdf" }),
    );
    assert.throws(() => readUploadToken(token), /no longer valid/);
  });

  test("refuses malformed input without throwing something shapeless", () => {
    for (const bad of ["", "nodot", "a.b.c", "!!!.???"]) {
      assert.throws(() => readUploadToken(bad), /no longer valid/, `accepted ${JSON.stringify(bad)}`);
    }
  });

  test("every failure reports the same thing", () => {
    // Distinguishing "bad signature" from "expired" tells a probing client
    // which half of the token to keep working on.
    const messages = new Set<string>();
    for (const token of [
      "nodot",
      `${Buffer.from("{}").toString("base64url")}.x`,
      issueUploadToken(payload({ expiresAt: Date.now() - 1 })),
    ]) {
      try {
        readUploadToken(token);
        assert.fail("expected a refusal");
      } catch (error) {
        messages.add((error as Error).message);
      }
    }
    assert.equal(messages.size, 1, `distinguishable refusals: ${[...messages].join(" | ")}`);
  });
});
