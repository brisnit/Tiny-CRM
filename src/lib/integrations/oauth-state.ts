import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import type { ProviderId } from "@/lib/integrations/providers";

/**
 * The `state` parameter and the PKCE verifier for an authorisation request.
 *
 * ## What state is actually for
 *
 * Not CSRF in the abstract: the concrete attack is that somebody causes *your*
 * browser to complete *their* authorisation, so their mailbox ends up connected
 * to your workspace — or yours to theirs. The callback therefore has to prove
 * three things before it exchanges a code:
 *
 *   1. this flow was started by us (signature),
 *   2. it was started by *this* person for *this* workspace and provider
 *      (payload, compared against the live session), and
 *   3. it was started recently (timestamp).
 *
 * ## Why this is signed rather than stored
 *
 * The obvious alternative is a server-side row keyed by a random nonce. That
 * needs a table, a cleanup job, and a decision about what happens when the row
 * is missing — and "missing" is indistinguishable from "replayed", which is the
 * case that matters. A signed, self-describing state needs none of that and
 * cannot be forged without `AUTH_SECRET`.
 *
 * The cost is honest: a signed state is replayable until it expires, because
 * nothing records that it was used. The PKCE verifier is what closes that —
 * it is held in a single-use cookie, so a replayed callback arrives without the
 * verifier and the token exchange fails at the provider. The expiry window is
 * ten minutes, which is long enough for a federated sign-in detour (the canary
 * tenant redirects through a third-party identity provider) and short enough
 * that a leaked URL in a browser history is not a standing risk.
 */

const STATE_VERSION = "v1";
const MAX_AGE_MS = 10 * 60 * 1000;

export type OAuthState = {
  provider: ProviderId;
  /** The workspace the connection will belong to, chosen before we started. */
  workspaceId: string;
  /** The person connecting. Compared against the session at the callback. */
  userId: string;
  /** Milliseconds since the epoch, for the expiry check. */
  issuedAt: number;
  /** Ties the state to the PKCE verifier cookie, so one cannot be swapped. */
  nonce: string;
};

function key(): Buffer {
  return createHash("sha256").update(`${env.authSecret}/integration-oauth-state/v1`).digest();
}

function sign(payload: string): string {
  return createHmac("sha256", key()).update(payload).digest("base64url");
}

/** `v1.<base64url payload>.<base64url hmac>` */
export function encodeState(state: Omit<OAuthState, "issuedAt" | "nonce"> & { nonce: string }): string {
  const payload = Buffer.from(
    JSON.stringify({ ...state, issuedAt: Date.now() } satisfies OAuthState),
  ).toString("base64url");
  return `${STATE_VERSION}.${payload}.${sign(payload)}`;
}

export class OAuthStateError extends AppError {
  constructor(reason: string) {
    // Deliberately uninformative to the browser. A callback that fails
    // verification is either a bug or an attack, and neither is helped by
    // telling the caller which check failed.
    super("forbidden", "That connection attempt could not be verified. Please start again.", {
      internal: `oauth state rejected: ${reason}`,
    });
    this.name = "OAuthStateError";
  }
}

/**
 * Verifies the signature and the age, and returns the payload.
 *
 * Does **not** check the payload against the session — that is the caller's
 * job, because only the caller knows who is asking. Separated so the signature
 * check cannot be mistaken for an authorisation check.
 */
export function decodeState(raw: string | null | undefined): OAuthState {
  if (!raw) throw new OAuthStateError("absent");
  const parts = raw.split(".");
  if (parts.length !== 3) throw new OAuthStateError("malformed");
  const [version, payload, mac] = parts as [string, string, string];
  if (version !== STATE_VERSION) throw new OAuthStateError(`unknown version ${version}`);

  const expected = sign(payload);
  // Constant-time, and length-checked first: timingSafeEqual throws on a
  // length mismatch rather than returning false.
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new OAuthStateError("bad signature");

  let decoded: OAuthState;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
  } catch {
    throw new OAuthStateError("payload is not JSON");
  }
  if (
    typeof decoded.provider !== "string" ||
    typeof decoded.workspaceId !== "string" ||
    typeof decoded.userId !== "string" ||
    typeof decoded.nonce !== "string" ||
    typeof decoded.issuedAt !== "number"
  ) {
    throw new OAuthStateError("payload is missing fields");
  }

  const age = Date.now() - decoded.issuedAt;
  // Negative age means a clock skew or a forged timestamp; both are refusals.
  if (age < 0 || age > MAX_AGE_MS) throw new OAuthStateError(`expired or future-dated (${age}ms)`);

  return decoded;
}

/**
 * A PKCE verifier and its S256 challenge.
 *
 * 32 random bytes, base64url — within RFC 7636's 43-to-128-character range and
 * the full entropy the spec allows. S256 only: the `plain` method offers no
 * protection against an intercepted authorisation code and both vendors
 * support S256.
 */
export function createPkcePair(): { verifier: string; challenge: string; method: "S256" } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

/** A nonce binding the signed state to the verifier cookie. */
export function createNonce(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Checks that the callback's state belongs to the person now presenting it.
 *
 * The third of the three proofs. A valid signature only shows that *we* issued
 * the state; this is what stops a state issued for one account being completed
 * by another, which is the attack that ends with somebody else's mailbox
 * connected to your workspace.
 */
export function assertStateMatchesSession(
  state: OAuthState,
  session: { userId: string; workspaceIds: readonly string[] },
): void {
  if (state.userId !== session.userId) throw new OAuthStateError("state belongs to another user");
  if (!session.workspaceIds.includes(state.workspaceId)) {
    throw new OAuthStateError("state names a workspace this session cannot reach");
  }
}
