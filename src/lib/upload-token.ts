import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";

/**
 * The upload token.
 *
 * A direct-to-storage upload is two round trips with a gap in the middle: the
 * server authorises an upload, the browser performs it, and the browser then
 * comes back to say it is done. The question that gap raises is the whole
 * reason this file exists — **when the browser comes back, what is it allowed
 * to tell us?**
 *
 * The naive answer is "the storage key it uploaded to, and which project to
 * attach it to". That answer is wrong, and quietly so. A client that chooses
 * those values can:
 *
 *   - name a key belonging to another workspace and attach that workspace's
 *     document to its own project, which is a cross-tenant read;
 *   - name a project it may not write to, if the confirmation step's
 *     authorisation is weaker than the request step's;
 *   - re-confirm one uploaded object many times;
 *   - declare a type or name unrelated to what was authorised.
 *
 * So the browser is told nothing it can usefully lie about. Everything decided
 * at request time — the key, the workspace, the project, the server-determined
 * MIME type, the display name — is serialised into this token, signed, and
 * handed back as one opaque string. On confirmation the server reads its own
 * decisions out of the token and ignores the client entirely.
 *
 * The signature is over the exact bytes that are returned, so a token cannot be
 * edited, and it carries its own expiry so an authorisation cannot be banked.
 *
 * This is deliberately *not* a session, a capability for the storage provider,
 * or a credential. It authorises nothing on its own: it only tells a later
 * request what an earlier request already decided. Authorisation is re-checked
 * against RLS at confirmation time regardless of what the token says, because a
 * grant can be revoked between the two calls.
 */

export type UploadTokenPayload = {
  /** Server-generated, opaque, workspace-prefixed. Never supplied by a client. */
  key: string;
  workspaceId: string;
  projectId: string;
  /** What the server determined from the extension, not the browser's claim. */
  mimeType: string;
  extension: string;
  /** Sanitised display name. A label, never a path. */
  displayName: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
};

/**
 * A key derived from the application secret rather than the secret itself, so
 * this token's signatures share no key material with session cookies. A
 * signature here can never be replayed as a signature there.
 */
function signingKey(): Buffer {
  return createHmac("sha256", env.authSecret).update("tiny-crm/upload-token/v1").digest();
}

function sign(body: string): string {
  return createHmac("sha256", signingKey()).update(body).digest("base64url");
}

/** Serialises and signs. The result is opaque to the browser. */
export function issueUploadToken(payload: UploadTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

/**
 * Verifies and deserialises.
 *
 * Throws rather than returning null: every failure here is either a tampered
 * token or an expired one, and both are refusals rather than conditions a
 * caller should be able to forget to check.
 */
export function readUploadToken(token: string): UploadTokenPayload {
  const refuse = (internal: string): never => {
    // One message for every failure. Distinguishing "bad signature" from
    // "expired" tells a probing client which half of the token to keep working
    // on, and the user-facing remedy is identical either way.
    throw new AppError("validation", "That upload is no longer valid. Try again.", {
      internal: `upload token rejected: ${internal}`,
    });
  };

  const parts = token.split(".");
  if (parts.length !== 2) refuse("malformed");

  const [body, provided] = parts as [string, string];

  const expected = Buffer.from(sign(body), "utf8");
  const actual = Buffer.from(provided, "utf8");
  // Length is checked first because timingSafeEqual throws on a mismatch, and
  // the comparison itself stays constant-time for equal-length input.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    refuse("signature mismatch");
  }

  let payload: UploadTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as UploadTokenPayload;
  } catch {
    return refuse("payload is not JSON");
  }

  // A signed token still has to describe something coherent: the signature
  // proves we issued it, not that this build understands it.
  const wellFormed =
    typeof payload?.key === "string" &&
    typeof payload.workspaceId === "string" &&
    typeof payload.projectId === "string" &&
    typeof payload.mimeType === "string" &&
    typeof payload.extension === "string" &&
    typeof payload.displayName === "string" &&
    typeof payload.expiresAt === "number";
  if (!wellFormed) refuse("payload is missing fields");

  if (Date.now() > payload.expiresAt) refuse("expired");

  // The key must sit under the workspace the token names. The key is generated
  // by `storageKeyFor` and never leaves the server, so this can only fail if
  // the two were built inconsistently — which is worth failing loudly over
  // rather than trusting, since it is the invariant the whole design rests on.
  if (!payload.key.startsWith(`workspaces/${payload.workspaceId}/`)) {
    refuse("key is not inside the workspace it names");
  }

  return payload;
}
