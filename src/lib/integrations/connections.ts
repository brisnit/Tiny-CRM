import "server-only";

import { db } from "@/lib/db";
import { decryptSecret, encryptSecret, SecretUnreadableError } from "@/lib/crypto";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { assertTenantContext } from "@/lib/documents/gate";
import { requireIntegrations } from "@/lib/integrations/gate";
import {
  accountEmailFrom,
  exchangeAuthorizationCode,
  missingScopes,
  OAuthExchangeError,
  refreshAccessToken,
  validateIdTokenClaims,
  type TokenSet,
  type Transport,
} from "@/lib/integrations/oauth-client";
import {
  assertStateMatchesSession,
  createNonce,
  createPkcePair,
  decodeState,
  encodeState,
} from "@/lib/integrations/oauth-state";
import { isConfigured, isOfferable, type ProviderConfig } from "@/lib/integrations/providers";

/**
 * The life of a connection: start it, complete it, keep its token usable, end
 * it.
 *
 * Every write here bumps `syncGeneration`. That column is the mechanism by
 * which disconnecting actually stops work, and it is worth being precise about
 * why nothing simpler would do. Deleting queued rows cannot stop a job that has
 * already been claimed and is mid-import; cancelling by status cannot stop a
 * job that re-reads nothing; and a job sitting in backoff will wake up later
 * regardless. A generation carried in the job payload and compared on every
 * pass means an obsolete worker exits on its own, whatever state it was in.
 */

/** What the callback needs to carry between the two halves of the handshake. */
export type ConnectionStart = {
  authorizeUrl: string;
  /** Held in a single-use, httpOnly cookie by the caller. */
  codeVerifier: string;
  nonce: string;
};

export function redirectUriFor(provider: ProviderConfig, origin: string): string {
  return `${origin}/api/integrations/${provider.vendor}/callback`;
}

/**
 * Builds the authorisation URL.
 *
 * Refuses for three separate reasons, in this order: the provider is not
 * approved for use at all, this environment has no credentials for it, or the
 * workspace is not flagged and entitled. Three checks rather than one because
 * they fail for different reasons and a customer should be told the right one.
 */
export async function beginConnection(input: {
  provider: ProviderConfig;
  workspaceId: string;
  userId: string;
  origin: string;
}): Promise<ConnectionStart> {
  if (!isOfferable(input.provider)) {
    throw new AppError("forbidden", input.provider.blockedReason ?? "That connection is not available yet.");
  }
  if (!isConfigured(input.provider)) {
    throw new AppError("internal", "That connection is not available right now.", {
      internal: `${input.provider.vendor} OAuth client is not configured in this environment`,
    });
  }
  await requireIntegrations(input.workspaceId);

  const { verifier, challenge, method } = createPkcePair();
  const nonce = createNonce();
  const state = encodeState({
    provider: input.provider.id,
    workspaceId: input.workspaceId,
    userId: input.userId,
    nonce,
  });

  const url = new URL(input.provider.authorizeUrl);
  url.searchParams.set("client_id", vendorClientId(input.provider));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUriFor(input.provider, input.origin));
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", input.provider.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", method);
  // The OIDC nonce, echoed back in the id_token. The same value is inside the
  // signed state, so the token, the state and the verifier cookie all have to
  // belong to one flow. Sending the state alone would leave the id_token
  // unbound: one captured from an earlier flow passes every other check.
  url.searchParams.set("nonce", nonce);
  // Forces a refresh token even on a re-consent, which Google otherwise omits —
  // and a connection without one stops syncing in an hour.
  if (input.provider.vendor === "google") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  }
  return { authorizeUrl: url.toString(), codeVerifier: verifier, nonce };
}

function vendorClientId(provider: ProviderConfig): string {
  const id = provider.vendor === "microsoft" ? env.microsoftClientId : env.googleClientId;
  if (!id) throw new AppError("internal", "That connection is not available right now.");
  return id;
}

function sealTokens(tokens: TokenSet): string {
  return encryptSecret(
    JSON.stringify({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      scope: tokens.scope,
      obtainedAt: new Date().toISOString(),
    }),
    "integration-credentials",
  );
}

type StoredTokens = {
  accessToken: string;
  refreshToken: string | null;
  scope: string;
  obtainedAt: string;
};

function openTokens(sealed: string): StoredTokens {
  return JSON.parse(decryptSecret(sealed, "integration-credentials")) as StoredTokens;
}

/**
 * Completes the handshake and stores the connection.
 *
 * The order of checks is the security content of this function:
 *
 *   1. the state's signature and age (`decodeState`);
 *   2. that it belongs to the person now presenting it
 *      (`assertStateMatchesSession`) — without this, a state issued for one
 *      account can be completed by another, which ends with somebody else's
 *      mailbox attached to your workspace;
 *   3. the code is exchanged only after both pass, so a forged callback never
 *      reaches the provider;
 *   4. the returned tenant is the one we expect (`assertTenant`);
 *   5. the granted scopes are the ones we need (`missingScopes`) — a consent
 *      screen lets a person decline individual permissions, so a completed
 *      handshake does not imply a usable connection;
 *   6. a refresh token exists, because without one the connection dies in an
 *      hour and looks healthy until it does.
 *
 * Only then is anything written.
 */
export async function completeConnection(input: {
  provider: ProviderConfig;
  code: string;
  state: string | null;
  codeVerifier: string | null;
  session: { userId: string; workspaceIds: readonly string[] };
  origin: string;
  transport?: Transport;
}): Promise<{ integrationId: string; accountEmail: string | null }> {
  const state = decodeState(input.state);
  assertStateMatchesSession(state, input.session);
  if (state.provider !== input.provider.id) {
    throw new AppError("forbidden", "That connection attempt could not be verified. Please start again.", {
      internal: `state names provider ${state.provider}, callback was for ${input.provider.id}`,
    });
  }
  if (!input.codeVerifier) {
    // The verifier lives in a single-use cookie. Its absence is what makes a
    // replayed callback URL fail, so this is a refusal rather than a fallback
    // to a non-PKCE exchange.
    throw new AppError("forbidden", "That connection attempt could not be verified. Please start again.", {
      internal: "no PKCE verifier cookie accompanied the callback",
    });
  }
  await requireIntegrations(state.workspaceId);

  const tokens = await exchangeAuthorizationCode({
    provider: input.provider,
    code: input.code,
    codeVerifier: input.codeVerifier,
    redirectUri: redirectUriFor(input.provider, input.origin),
    transport: input.transport,
  });

  /**
   * Looked up BEFORE the token is validated, because on a multi-tenant
   * authority the validation needs to know which tenant this connection has
   * used before. Validating first and checking the tenant afterwards would
   * mean the window where a token from another organisation had already
   * been accepted.
   */
  const existing = await db.integration.findUnique({
    where: {
      workspaceId_userId_provider: {
        workspaceId: state.workspaceId,
        userId: state.userId,
        provider: input.provider.id,
      },
    },
    select: { id: true, syncGeneration: true, providerTenantId: true },
  });

  validateIdTokenClaims({
    provider: input.provider,
    claims: tokens.claims,
    expectedNonce: state.nonce,
    expectedTenant: existing?.providerTenantId ?? null,
  });

  const missing = missingScopes(input.provider, tokens.scope);
  if (missing.length > 0) {
    throw new OAuthExchangeError(
      "Some permissions were not granted, so this cannot sync. Please connect again and accept all of them.",
      "scope_declined",
      `granted scopes are missing ${missing.join(", ")}`,
    );
  }
  if (!tokens.refreshToken) {
    throw new OAuthExchangeError(
      "That connection could not be kept open. Please try connecting again.",
      "no_refresh_token",
      "the provider issued no refresh token, so the connection would stop working within the hour",
    );
  }

  const accountEmail = accountEmailFrom(tokens.claims);

  const data = {
    status: "connected",
    accountEmail,
    // Recorded on the first connection and never changed afterwards: the
    // check above refuses a token from a different tenant, so reaching here
    // means this is either the same tenant or the first one. Null for Google,
    // which issues no `tid`.
    providerTenantId: tokens.claims?.tid ?? existing?.providerTenantId ?? null,
    scopes: tokens.scope,
    credentials: sealTokens(tokens),
    tokenExpiresAt: tokens.expiresAt,
    connectedAt: new Date(),
    disconnectedAt: null,
    lastError: null,
    lastErrorAt: null,
    // Momentary: `startBackfill` below moves this to `backfilling` in the same
    // request. It is written here so a connection that somehow fails before
    // the backfill is queued does not claim to be backfilling.
    syncState: "idle",
    // Reconnecting is a new generation: anything queued under the old one —
    // including a backfill that was halfway through — must not resume against
    // a different grant.
    syncGeneration: (existing?.syncGeneration ?? 0) + 1,
    // A reconnect starts its bounded backfill again rather than trusting a
    // cursor issued under the previous grant.
    syncCursor: null,
    backfillCompletedAt: null,
    // The page budget belongs to the **attempt**, so it resets here and
    // nowhere else. It is deliberately not reset by a retry or by a queued
    // continuation: forty chained jobs share one budget, and a counter that
    // reset per job would be the same as having no cap at all.
    pagesImported: 0,
    backfillTruncated: false,
    importedThrough: null,
  };

  const row = existing
    ? await db.integration.update({ where: { id: existing.id }, data, select: { id: true } })
    : await db.integration.create({
        data: {
          ...data,
          workspaceId: state.workspaceId,
          userId: state.userId,
          provider: input.provider.id,
        },
        select: { id: true },
      });

  // Start the backfill: mark the connection as backfilling and queue its first
  // page. This goes through `startBackfill` rather than enqueueing inline,
  // because the two had drifted — the inline version left `syncState` at
  // `idle`, which is the same value a *finished* import has, so a queued
  // backfill and a completed one were indistinguishable in the database and on
  // the Settings page.
  const { startBackfill } = await import("@/lib/integrations/sync/worker");
  await startBackfill({
    integrationId: row.id,
    workspaceId: state.workspaceId,
    ownerUserId: state.userId,
    generation: data.syncGeneration,
  });

  // Queueing is not running: the caller must drain. The callback route calls
  // `dispatchSoon()` for that, as every other write path does from the request
  // boundary rather than from inside a domain function — otherwise completing
  // a connection in a test would fire a detached job that makes a real Graph
  // request. `/api/cron/jobs` remains the guarantee of eventual delivery; the
  // route's dispatch is what makes the common case immediate.

  log.info("integration connected", {
    provider: input.provider.id,
    workspaceId: state.workspaceId,
    generation: data.syncGeneration,
  });
  return { integrationId: row.id, accountEmail };
}

/**
 * Ends a connection.
 *
 * `keepImported` is the explicit decision about retained data, and it is a
 * parameter rather than a policy because it is the customer's choice. Keeping
 * is the default elsewhere in the product: correspondence filed against a deal
 * should not vanish because a mailbox was disconnected.
 *
 * Either way the credentials are destroyed and the generation is bumped, so no
 * further import can happen under this connection.
 *
 * **What a disconnect does not do is release `integrationId` on the rows it
 * imported.** The Integration row survives — only its credentials are
 * destroyed — so `onDelete: SetNull` does not fire, and the kept messages still
 * name the connection they came from. That is deliberate: it is what lets the
 * UI say which mailbox a message arrived from, and what a later "remove this
 * connection's data" would target. The link is released only if the Integration
 * row is deleted outright.
 *
 * An earlier version of this comment claimed the opposite. It was wrong, and it
 * was found by running a disconnect against the real canary connection rather
 * than by re-reading the code — the test that was supposed to cover it deleted
 * the Integration row, which is a different path with a different outcome.
 */
export async function disconnectConnection(input: {
  integrationId: string;
  userId: string;
  keepImported: boolean;
}): Promise<{ removedEmails: number; removedEvents: number }> {
  // Integration, EmailMessage and CalendarEvent are all under row-level
  // security. Without a context a read returns nothing and a write is refused
  // *silently*, so a disconnect would report success having destroyed nothing.
  // Asserting the call shape means that fails loudly, and on SQLite too, where
  // there are no policies to notice it.
  assertTenantContext("disconnectConnection");
  const row = await db.integration.findUnique({
    where: { id: input.integrationId },
    select: { id: true, userId: true, syncGeneration: true, workspaceId: true, provider: true },
  });
  // RLS already restricts this table to its owner; the explicit check is here
  // so the same refusal happens on SQLite, where there are no policies.
  if (!row || row.userId !== input.userId) {
    throw new AppError("not_found", "That connection does not exist.");
  }

  let removedEmails = 0;
  let removedEvents = 0;
  if (!input.keepImported) {
    removedEmails = (await db.emailMessage.deleteMany({ where: { integrationId: row.id } })).count;
    removedEvents = (await db.calendarEvent.deleteMany({ where: { integrationId: row.id } })).count;
  }

  await db.integration.update({
    where: { id: row.id },
    data: {
      status: "disconnected",
      // The whole point: no token survives a disconnect.
      credentials: null,
      tokenExpiresAt: null,
      disconnectedAt: new Date(),
      syncState: "idle",
      syncCursor: null,
      backfillCompletedAt: null,
      syncGeneration: row.syncGeneration + 1,
    },
  });

  log.info("integration disconnected", {
    provider: row.provider,
    workspaceId: row.workspaceId,
    keptImported: input.keepImported,
    removedEmails,
    removedEvents,
    generation: row.syncGeneration + 1,
  });
  return { removedEmails, removedEvents };
}

/** Refresh a little before expiry, so a sync pass does not race the clock. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * The access token for a connection, refreshed if it is close to expiring.
 *
 * Refresh failure is classified rather than retried blindly. `invalid_grant`
 * means the customer revoked access or changed their password: no amount of
 * retrying fixes it, and the connection is marked `reauth_required` so the UI
 * can ask them to reconnect instead of a worker hammering the endpoint. Any
 * other failure is left as `error`, which is retryable.
 */
export async function accessTokenFor(
  integrationId: string,
  provider: ProviderConfig,
  transport?: Transport,
): Promise<string> {
  assertTenantContext("accessTokenFor");
  const row = await db.integration.findUniqueOrThrow({
    where: { id: integrationId },
    select: { id: true, credentials: true, tokenExpiresAt: true, status: true, syncGeneration: true },
  });
  if (row.status !== "connected" || !row.credentials) {
    throw new AppError("forbidden", "That connection needs to be reconnected.", {
      internal: `integration ${integrationId} is ${row.status} with ${row.credentials ? "" : "no "}credentials`,
    });
  }

  let stored: StoredTokens;
  try {
    stored = openTokens(row.credentials);
  } catch (error) {
    // Undecryptable means AUTH_SECRET changed, or the column was tampered
    // with. Either way the remedy is reconnecting, not retrying.
    await markReauthRequired(row.id, "stored credentials could not be read");
    throw error instanceof SecretUnreadableError ? error : new SecretUnreadableError("unknown");
  }

  const expiresAt = row.tokenExpiresAt?.getTime() ?? 0;
  if (expiresAt - Date.now() > REFRESH_MARGIN_MS) return stored.accessToken;
  if (!stored.refreshToken) {
    await markReauthRequired(row.id, "no refresh token is stored");
    throw new AppError("forbidden", "That connection needs to be reconnected.");
  }

  try {
    const refreshed = await refreshAccessToken({
      provider,
      refreshToken: stored.refreshToken,
      transport,
    });
    await db.integration.update({
      where: { id: row.id },
      data: {
        // Providers may or may not rotate the refresh token; keep the new one
        // when offered and the old one when not, because discarding a working
        // refresh token would end the connection.
        credentials: sealTokens({
          ...refreshed,
          refreshToken: refreshed.refreshToken ?? stored.refreshToken,
        }),
        tokenExpiresAt: refreshed.expiresAt,
        status: "connected",
        lastError: null,
        lastErrorAt: null,
      },
    });
    return refreshed.accessToken;
  } catch (error) {
    const code = error instanceof OAuthExchangeError ? error.providerCode : "unknown";
    if (code === "invalid_grant") {
      await markReauthRequired(row.id, "the provider rejected the refresh token");
      throw new AppError("forbidden", "That connection needs to be reconnected.", {
        internal: `refresh refused for integration ${row.id}: invalid_grant`,
      });
    }
    await db.integration.update({
      where: { id: row.id },
      data: {
        status: "error",
        lastError: "Could not reach the provider to refresh access. It will be retried.",
        lastErrorAt: new Date(),
      },
    });
    throw error;
  }
}

async function markReauthRequired(integrationId: string, internal: string): Promise<void> {
  await db.integration.update({
    where: { id: integrationId },
    data: {
      status: "reauth_required",
      credentials: null,
      tokenExpiresAt: null,
      lastError: "Access was revoked or has expired. Reconnect to resume syncing.",
      lastErrorAt: new Date(),
    },
  });
  log.warn("integration needs reauthorisation", { integrationId, reason: internal });
}

/**
 * Whether a job may still act for this connection.
 *
 * Called by every sync pass. A job carries the generation it was enqueued
 * under; if it no longer matches, the connection has been disconnected or
 * reconnected since and the job exits rather than importing into a grant that
 * no longer exists.
 */
export async function generationIsCurrent(
  integrationId: string,
  generation: number,
): Promise<boolean> {
  // A worker that lost its context must not read "generation does not match"
  // as "stand down" — that is the same answer as a revoked connection, and the
  // two need different handling. Refusing is the only safe reading.
  assertTenantContext("generationIsCurrent");
  const row = await db.integration.findUnique({
    where: { id: integrationId },
    select: { syncGeneration: true, status: true },
  });
  return Boolean(row && row.status === "connected" && row.syncGeneration === generation);
}
