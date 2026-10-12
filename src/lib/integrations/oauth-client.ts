import "server-only";

import { AppError } from "@/lib/errors";
import { env } from "@/lib/env";
import {
  expectedMicrosoftTenant,
  type ProviderConfig,
} from "@/lib/integrations/providers";

/**
 * The token endpoint: exchanging a code, refreshing, and deciding whether the
 * result is one we may trust.
 *
 * `transport` is injectable so the whole of this module is testable without a
 * provider. That matters for honesty as much as for convenience: everything CI
 * exercises here is a **mocked** provider, and the real handshake is a separate,
 * manual verification. A test that quietly hit Microsoft would blur the two.
 */

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export type TokenSet = {
  accessToken: string;
  /**
   * Absent when the provider declines to issue one — Google omits it on a
   * re-consent unless `prompt=consent` is forced. A connection with no refresh
   * token cannot sync beyond the access token's hour, so the caller treats a
   * missing one as a failed connection rather than storing a connection that
   * will quietly stop working.
   */
  refreshToken: string | null;
  /** Absolute, computed from `expires_in` at the moment of the response. */
  expiresAt: Date;
  /** What the provider actually granted, which may be less than we asked. */
  scope: string;
  /** Claims from the id_token, when one was issued. */
  claims: IdTokenClaims | null;
};

export type IdTokenClaims = {
  /** Tenant the token was minted by. Microsoft only. */
  tid?: string;
  iss?: string;
  /** Must be this client. A token minted for another app is not ours to trust. */
  aud?: string | string[];
  /** Seconds since the epoch. */
  exp?: number;
  iat?: number;
  nbf?: number;
  /** Echoed from the authorisation request, binding the token to this flow. */
  nonce?: string;
  sub?: string;
  /** The signed-in account, in rough order of usefulness. */
  preferred_username?: string;
  email?: string;
  upn?: string;
  name?: string;
};

export class OAuthExchangeError extends AppError {
  readonly providerCode: string;
  constructor(message: string, providerCode: string, internal: string) {
    super("forbidden", message, { internal });
    this.name = "OAuthExchangeError";
    this.providerCode = providerCode;
  }
}

function credentialsFor(provider: ProviderConfig): { id: string; secret: string } {
  const id = provider.vendor === "microsoft" ? env.microsoftClientId : env.googleClientId;
  const secret =
    provider.vendor === "microsoft" ? env.microsoftClientSecret : env.googleClientSecret;
  if (!id || !secret) {
    throw new AppError("internal", "That connection is not available right now.", {
      internal: `${provider.vendor} OAuth client is not configured in this environment`,
    });
  }
  return { id, secret };
}

/**
 * Reads an id_token's claims **without verifying its signature**.
 *
 * ## The exact conditions that make this sound, all of which must hold
 *
 * OpenID Connect Core 3.1.3.7 ("ID Token Validation") permits skipping
 * signature validation only for a token obtained by direct communication with
 * the token endpoint, where TLS server authentication stands in for it. Every
 * one of these is true of this call site and none of them is incidental:
 *
 *   1. **The token arrives in a response body we requested**, not in a request
 *      somebody made to us. There is no attacker-chosen path into this
 *      function.
 *   2. **The connection is server-to-server HTTPS to a hard-coded host** from
 *      `PROVIDERS` — not a URL from a discovery document, a redirect, or any
 *      other value an attacker could influence. TLS certificate validation is
 *      therefore what authenticates the issuer.
 *   3. **The request carried our client secret**, so the response is to an
 *      authenticated client.
 *   4. **The claims are still fully validated** by `validateIdTokenClaims`
 *      below — audience, expiry, not-before, issuer, tenant and nonce.
 *      Skipping the signature is a judgement about the *channel*; skipping the
 *      claims would be checking nothing at all.
 *
 * ## Where this must never be used
 *
 * **Never on a token that reached us through a browser** — a query parameter,
 * a fragment, a form post, a header, a websocket frame, or anything a client
 * supplied. In those cases none of conditions 1 to 3 holds: the channel proves
 * nothing about who minted the document, so the signature is the only thing
 * that does, and it must be verified against the provider's JWKS.
 *
 * This codebase has no implicit or hybrid flow and no client-side token
 * handling, so no such path exists today. The name of this function says where
 * it may be called from, and that is deliberate: `readIdTokenClaims` would
 * have been an invitation to call it on anything shaped like a JWT.
 */
function claimsFromDirectTokenResponse(idToken: string | undefined): IdTokenClaims | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as IdTokenClaims;
  } catch {
    return null;
  }
}

/**
 * The full set of id_token checks, in one place so none can be forgotten.
 *
 * `tid` and `iss` alone are not OIDC validation, which is what the first
 * version of this file settled for. A token can name the right tenant and
 * still not be ours: minted for a different application, minted an hour ago
 * and replayed, or minted for a different authorisation attempt entirely.
 * Each check below answers one of those.
 *
 * Sixty seconds of clock skew is allowed on the time-based claims. Both
 * providers' clocks are good, but a server a second behind must not refuse a
 * valid connection.
 */
const CLOCK_SKEW_SECONDS = 60;

export function validateIdTokenClaims(input: {
  provider: ProviderConfig;
  claims: IdTokenClaims | null;
  /** The nonce sent in the authorisation request, where the vendor echoes it. */
  expectedNonce: string;
  now?: Date;
}): void {
  const { provider, claims } = input;
  const now = Math.floor((input.now?.getTime() ?? Date.now()) / 1000);

  // Microsoft issues an id_token whenever `openid` is requested, which it
  // always is. Google does too. An absent one means something is wrong with
  // the request, not that validation may be skipped.
  if (!claims) {
    throw new OAuthExchangeError(
      "That connection could not be verified. Please try again.",
      "no_id_token",
      "the token response carried no id_token, so none of the claims could be checked",
    );
  }

  // --- Audience -----------------------------------------------------------
  // A token minted for another application is not ours to accept, even from
  // the right tenant. `aud` may be a string or an array.
  const expectedAudience =
    provider.vendor === "microsoft" ? env.microsoftClientId : env.googleClientId;
  if (!expectedAudience) {
    throw new AppError("internal", "That connection is not available right now.", {
      internal: `${provider.vendor} client id is unset, so the audience cannot be validated`,
    });
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(expectedAudience)) {
    throw new OAuthExchangeError(
      "That connection could not be verified. Please try again.",
      "audience_mismatch",
      `id_token aud ${JSON.stringify(claims.aud)} is not this client`,
    );
  }

  // --- Expiry and not-before ---------------------------------------------
  if (typeof claims.exp !== "number") {
    throw new OAuthExchangeError(
      "That connection could not be verified. Please try again.",
      "no_exp",
      "id_token has no exp claim, so it never expires — refused",
    );
  }
  if (claims.exp + CLOCK_SKEW_SECONDS < now) {
    throw new OAuthExchangeError(
      "That connection attempt took too long. Please try again.",
      "id_token_expired",
      `id_token expired at ${claims.exp}, now ${now}`,
    );
  }
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > now) {
    throw new OAuthExchangeError(
      "That connection could not be verified. Please try again.",
      "id_token_not_yet_valid",
      `id_token is not valid before ${claims.nbf}, now ${now}`,
    );
  }
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_SECONDS > now) {
    throw new OAuthExchangeError(
      "That connection could not be verified. Please try again.",
      "id_token_future_dated",
      `id_token was issued at ${claims.iat}, in the future relative to ${now}`,
    );
  }

  // --- Nonce --------------------------------------------------------------
  // Binds this token to this authorisation request. Without it, an id_token
  // captured from an earlier flow satisfies every other check here.
  if (!claims.nonce) {
    throw new OAuthExchangeError(
      "That connection could not be verified. Please try again.",
      "no_nonce",
      "id_token carries no nonce, so it cannot be tied to this authorisation request",
    );
  }
  if (claims.nonce !== input.expectedNonce) {
    throw new OAuthExchangeError(
      "That connection could not be verified. Please start again.",
      "nonce_mismatch",
      "id_token nonce does not match the one sent in the authorisation request",
    );
  }

  // --- Tenant and issuer --------------------------------------------------
  assertTenant(provider, claims);
}

/**
 * Refuses a token that was not minted by the tenant we are configured for.
 *
 * The check this exists for: a single-tenant app on a tenant-specific
 * authority should only ever see its own tenant, so a `tid` that disagrees
 * means either a misconfiguration or something stranger, and in both cases
 * importing a stranger's mailbox is the wrong response to "the handshake
 * completed". `/common` would have left nothing to compare against, which is
 * the real reason it was the wrong authority.
 *
 * Google issues no `tid`, and its issuer is fixed, so that is checked instead.
 */
export function assertTenant(provider: ProviderConfig, claims: IdTokenClaims | null): void {
  if (provider.vendor === "google") {
    const issuer = claims?.iss ?? "";
    if (issuer !== "https://accounts.google.com" && issuer !== "accounts.google.com") {
      throw new OAuthExchangeError(
        "That connection could not be verified. Please try again.",
        "issuer_mismatch",
        `id_token issuer ${JSON.stringify(issuer)} is not Google`,
      );
    }
    return;
  }

  const expected = expectedMicrosoftTenant();
  if (!expected) {
    throw new AppError("internal", "That connection is not available right now.", {
      internal: "MICROSOFT_TENANT_ID is not set, so the returned tenant cannot be validated",
    });
  }
  if (!claims?.tid) {
    throw new OAuthExchangeError(
      "That connection could not be verified. Please try again.",
      "no_tid",
      "the token response carried no id_token tid claim, so the tenant could not be validated",
    );
  }
  if (claims.tid.toLowerCase() !== expected.toLowerCase()) {
    throw new OAuthExchangeError(
      "That account belongs to a different organisation.",
      "tenant_mismatch",
      `token tid ${claims.tid} is not the configured tenant ${expected}`,
    );
  }
  // The issuer must name the same tenant. A `tid` claim alone could in
  // principle be carried by a token from elsewhere; the issuer is what ties the
  // document to the authority we asked.
  if (claims.iss && !claims.iss.includes(expected)) {
    throw new OAuthExchangeError(
      "That connection could not be verified. Please try again.",
      "issuer_mismatch",
      `token issuer ${claims.iss} does not name the configured tenant`,
    );
  }
}

/**
 * Checks the provider granted what the connector needs.
 *
 * A consent screen lets a person decline individual permissions, so a
 * successful handshake does not imply a usable connection. Storing one anyway
 * produces a connection that looks fine and silently imports nothing, which is
 * the worst of the available outcomes.
 *
 * Compared case-insensitively and ignoring the OIDC scopes, which providers
 * echo back inconsistently — Microsoft returns them, Google does not.
 */
const OIDC_SCOPES = new Set(["openid", "profile", "email", "offline_access"]);

export function missingScopes(provider: ProviderConfig, granted: string): string[] {
  const got = new Set(granted.split(/\s+/).filter(Boolean).map((s) => s.toLowerCase()));
  return provider.scopes
    .filter((wanted) => !OIDC_SCOPES.has(wanted.toLowerCase()))
    .filter((wanted) => {
      const lower = wanted.toLowerCase();
      // Providers return either the full URI or the bare permission name.
      const bare = lower.split("/").pop() ?? lower;
      return !got.has(lower) && !got.has(bare);
    });
}

async function post(
  provider: ProviderConfig,
  body: URLSearchParams,
  transport: Transport,
): Promise<TokenSet> {
  const response = await transport(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });

  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new OAuthExchangeError(
      "That connection could not be completed. Please try again.",
      "unparseable",
      // The body can quote a token, so its length is reported rather than its
      // content.
      `token endpoint returned ${response.status} with ${text.length} unparseable bytes`,
    );
  }

  if (!response.ok) {
    const code = String(parsed.error ?? `http_${response.status}`);
    throw new OAuthExchangeError(
      code === "invalid_grant"
        ? "That authorisation has expired or been revoked. Please connect again."
        : "That connection could not be completed. Please try again.",
      code,
      // `error_description` carries AADSTS codes, which are diagnostic and
      // contain no secret. Truncated, because it can be long.
      `token endpoint ${response.status} ${code}: ${String(parsed.error_description ?? "").slice(0, 300)}`,
    );
  }

  const accessToken = typeof parsed.access_token === "string" ? parsed.access_token : "";
  if (!accessToken) {
    throw new OAuthExchangeError(
      "That connection could not be completed. Please try again.",
      "no_access_token",
      "token endpoint returned 200 with no access_token",
    );
  }

  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  return {
    accessToken,
    refreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : null,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scope: typeof parsed.scope === "string" ? parsed.scope : "",
    claims: claimsFromDirectTokenResponse(
      typeof parsed.id_token === "string" ? parsed.id_token : undefined,
    ),
  };
}

export async function exchangeAuthorizationCode(input: {
  provider: ProviderConfig;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  transport?: Transport;
}): Promise<TokenSet> {
  const { id, secret } = credentialsFor(input.provider);
  return post(
    input.provider,
    new URLSearchParams({
      client_id: id,
      client_secret: secret,
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
    input.transport ?? fetch,
  );
}

export async function refreshAccessToken(input: {
  provider: ProviderConfig;
  refreshToken: string;
  transport?: Transport;
}): Promise<TokenSet> {
  const { id, secret } = credentialsFor(input.provider);
  return post(
    input.provider,
    new URLSearchParams({
      client_id: id,
      client_secret: secret,
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      // Asked for again on refresh because Microsoft scopes the new token to
      // what is requested, and omitting them narrows it silently.
      scope: input.provider.scopes.join(" "),
    }),
    input.transport ?? fetch,
  );
}

/** The address to show for the connection, from whichever claim carries it. */
export function accountEmailFrom(claims: IdTokenClaims | null): string | null {
  return claims?.preferred_username ?? claims?.email ?? claims?.upn ?? null;
}
