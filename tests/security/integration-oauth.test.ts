// MUST be first: it sets the canary identifiers before src/lib/env.ts and
// src/lib/integrations/providers.ts capture them at module load.
import { CANARY_CLIENT_ID, CANARY_TENANT_ID } from "../helpers/microsoft-test-env";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { db, createTenant, cleanupTenants, type Tenant } from "../helpers/fixtures";
import { withTenantContext } from "../../src/lib/tenant-db";
import {
  assertStateMatchesSession,
  decodeState,
  encodeState,
  OAuthStateError,
} from "../../src/lib/integrations/oauth-state";
import {
  assertTenant,
  missingScopes,
  type Transport,
} from "../../src/lib/integrations/oauth-client";
import {
  beginConnection,
  completeConnection,
  disconnectConnection,
  generationIsCurrent,
} from "../../src/lib/integrations/connections";
import { PROVIDERS } from "../../src/lib/integrations/providers";

/**
 * The OAuth handshake's refusals.
 *
 * ## Mocked, and deliberately so
 *
 * **Every test in this file talks to a fake token endpoint.** Nothing here
 * reaches Microsoft or Google, no real code is exchanged, and a pass proves
 * nothing about the live providers. The real handshake is verified by a person
 * in a browser against the canary tenant, and that is recorded separately in
 * docs/INTEGRATIONS.md. Mixing the two would let a green suite imply a working
 * connection.
 *
 * What these *do* prove is the part that mocking cannot fake: which checks run,
 * in which order, and what is written when one fails.
 */

const ORIGIN = "http://localhost:3000";
const TENANT = CANARY_TENANT_ID;
/**
 * The nonce every state in this suite carries, so a token fixture can echo it.
 * Real flows use a random one per attempt; fixing it here is what lets a test
 * assert the *mismatch* case deliberately rather than by accident.
 */
const FIXED_NONCE = "nonce-for-tests";

let owner: Tenant;
let other: Tenant;

/** A token endpoint that returns whatever a test needs it to. */
function fakeEndpoint(body: Record<string, unknown>, status = 200): Transport {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

/**
 * A complete, valid claim set. Tests that care about one claim override it, so
 * each failure is attributable to the claim under test rather than to a
 * fixture that was never valid.
 */
function validClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    tid: TENANT,
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    aud: CANARY_CLIENT_ID,
    exp: now + 3600,
    iat: now,
    nbf: now,
    nonce: FIXED_NONCE,
    sub: "subject-id",
    preferred_username: "hello@artifactdigital.co",
    ...overrides,
  };
}

function idTokenWith(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.signature-not-checked`;
}

/** A token response shaped like Microsoft's, granting everything we asked. */
function microsoftSuccess(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "fake-access-token",
    refresh_token: "fake-refresh-token",
    expires_in: 3600,
    scope:
      "openid profile email offline_access https://graph.microsoft.com/User.Read " +
      "https://graph.microsoft.com/Mail.Read",
    id_token: idTokenWith(validClaims()),
    ...overrides,
  };
}

before(async () => {
  owner = await createTenant("OAuthOwner", { plan: "pro" });
  other = await createTenant("OAuthOther", { plan: "pro" });
  for (const t of [owner, other]) {
    await db.featureFlag.upsert({
      where: { key_workspaceId: { key: "integrations", workspaceId: t.workspaceId } },
      create: { key: "integrations", workspaceId: t.workspaceId, enabled: true, updatedAt: new Date() },
      update: { enabled: true, updatedAt: new Date() },
    });
  }
});

after(async () => {
  for (const t of [owner, other]) {
    await db.integration.deleteMany({ where: { workspaceId: t.workspaceId } });
    await db.featureFlag.deleteMany({ where: { workspaceId: t.workspaceId } });
  }
  await cleanupTenants([owner, other]);
  await db.$disconnect();
});

const inContext = <T>(t: Tenant, fn: () => Promise<T>) =>
  withTenantContext(
    { workspaceIds: [t.workspaceId], userId: t.ownerId, restrictedWorkspaceIds: [] },
    fn,
  );

const session = (t: Tenant) => ({ userId: t.ownerId, workspaceIds: [t.workspaceId] });

/**
 * Asserts the refusal's *reason*, which lives in `internal`, and that the
 * customer-facing message stays generic.
 *
 * Both halves matter. A callback that fails verification is either a bug or an
 * attack, and telling the caller which check failed helps only the attacker —
 * so the message is deliberately uninformative and the diagnostic goes to the
 * log. My first version of these tests matched on `message` and therefore
 * passed for any refusal at all.
 */
function refusalReason(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const app = error as { message: string; internal?: unknown };
    assert.match(
      app.message,
      /could not be verified|please start again/i,
      "the refusal message is not the generic one",
    );
    return String(app.internal ?? "");
  }
  assert.fail("expected a refusal");
}

describe("the authorisation request", () => {
  test("carries PKCE, a signed state, and the tenant-specific authority", async () => {
    const start = await inContext(owner, () =>
      beginConnection({
        provider: PROVIDERS.outlook,
        workspaceId: owner.workspaceId,
        userId: owner.ownerId,
        origin: ORIGIN,
      }),
    );
    const url = new URL(start.authorizeUrl);

    // The authority is the thing that was wrong before: /common would have
    // left nothing to validate the returned tenant against.
    assert.equal(url.origin, "https://login.microsoftonline.com");
    assert.ok(url.pathname.startsWith(`/${TENANT}/`), `authority was ${url.pathname}`);
    assert.ok(!url.pathname.includes("common"), "the authority is /common");

    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const challenge = url.searchParams.get("code_challenge") ?? "";
    assert.equal(
      challenge,
      createHash("sha256").update(start.codeVerifier).digest("base64url"),
      "the challenge is not the S256 hash of the verifier",
    );
    assert.equal(url.searchParams.get("redirect_uri"), `${ORIGIN}/api/integrations/microsoft/callback`);
    // No write scope, in any form.
    assert.doesNotMatch(url.searchParams.get("scope") ?? "", /\.(write|send)|Mail\.Send|ReadWrite/i);
  });

  test("Gmail cannot be started even with the flag on and the plan entitled", async () => {
    // Approval is a third gate, separate from the flag and the plan, so
    // switching integrations on must not make a restricted-scope provider
    // connectable.
    await assert.rejects(
      () =>
        inContext(owner, () =>
          beginConnection({
            provider: PROVIDERS.gmail,
            workspaceId: owner.workspaceId,
            userId: owner.ownerId,
            origin: ORIGIN,
          }),
        ),
      /restricted Google scope|not available yet/i,
      "Gmail was connectable",
    );
  });
});

describe("the callback refuses anything it cannot verify", () => {
  const verifier = "a-verifier-that-will-not-be-checked-by-the-fake";

  test("a tampered state is refused", async () => {
    const good = encodeState({
      provider: "outlook", workspaceId: owner.workspaceId, userId: owner.ownerId, nonce: FIXED_NONCE,
    });
    const parts = good.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${"A".repeat(parts[2]!.length)}`;
    assert.throws(() => decodeState(tampered), OAuthStateError);
  });

  test("a state issued for another person cannot be completed by me", async () => {
    // The attack: somebody causes your browser to finish their authorisation,
    // so their mailbox lands in your workspace — or yours in theirs.
    const theirs = decodeState(
      encodeState({
        provider: "outlook", workspaceId: other.workspaceId, userId: other.ownerId, nonce: FIXED_NONCE,
      }),
    );
    const reason = refusalReason(() => assertStateMatchesSession(theirs, session(owner)));
    assert.match(reason, /belongs to another user/, "a state for another account was accepted");
  });

  test("a state naming a workspace I cannot reach is refused", async () => {
    const elsewhere = decodeState(
      encodeState({
        provider: "outlook", workspaceId: other.workspaceId, userId: owner.ownerId, nonce: FIXED_NONCE,
      }),
    );
    const reason = refusalReason(() => assertStateMatchesSession(elsewhere, session(owner)));
    assert.match(reason, /cannot reach/, "a state naming an unreachable workspace was accepted");
  });

  test("an expired state is refused", async () => {
    const stale = encodeState({
      provider: "outlook", workspaceId: owner.workspaceId, userId: owner.ownerId, nonce: FIXED_NONCE,
    });
    const [, payload] = stale.split(".");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    decoded.issuedAt = Date.now() - 20 * 60 * 1000;
    // Re-signing with the real key, so this tests the age check rather than
    // the signature check.
    const { createHmac, createHash: h } = await import("node:crypto");
    const { env } = await import("../../src/lib/env");
    const body = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    const key = h("sha256").update(`${env.authSecret}/integration-oauth-state/v1`).digest();
    const mac = createHmac("sha256", key).update(body).digest("base64url");
    const reason = refusalReason(() => decodeState(`v1.${body}.${mac}`));
    assert.match(reason, /expired or future-dated/i, "a twenty-minute-old state was accepted");
  });

  test("a callback with no PKCE verifier is refused rather than downgraded", async () => {
    const state = encodeState({
      provider: "outlook", workspaceId: owner.workspaceId, userId: owner.ownerId, nonce: FIXED_NONCE,
    });
    await assert.rejects(
      () =>
        inContext(owner, () =>
          completeConnection({
            provider: PROVIDERS.outlook,
            code: "any",
            state,
            codeVerifier: null,
            session: session(owner),
            origin: ORIGIN,
            transport: fakeEndpoint(microsoftSuccess()),
          }),
        ),
      /could not be verified/i,
    );
    const rows = await db.integration.count({ where: { workspaceId: owner.workspaceId } });
    assert.equal(rows, 0, "a connection was stored despite a missing verifier");
  });

  test("completeConnection itself refuses a state belonging to another person", async () => {
    // Driven through the real entry point, not through assertStateMatchesSession.
    // Mutation testing caught that: removing the session check from
    // completeConnection left all eighteen tests passing, because every
    // cross-user assertion called the helper directly. This is the attack —
    // somebody else's authorisation completed in my session — so it has to be
    // covered where it is actually prevented.
    const theirState = encodeState({
      provider: "outlook",
      workspaceId: other.workspaceId,
      userId: other.ownerId,
      nonce: FIXED_NONCE,
    });
    await assert.rejects(
      () =>
        inContext(owner, () =>
          completeConnection({
            provider: PROVIDERS.outlook,
            code: "any",
            state: theirState,
            codeVerifier: "verifier",
            session: session(owner),
            origin: ORIGIN,
            transport: fakeEndpoint(microsoftSuccess()),
          }),
        ),
      /could not be verified/i,
      "a state issued for another account was completed in this session",
    );
    assert.equal(
      await db.integration.count({ where: { workspaceId: other.workspaceId } }),
      0,
      "a connection was created in somebody else's workspace",
    );
  });

  test("completeConnection itself refuses a token from the wrong tenant", async () => {
    // Also found by mutation: removing assertTenant from completeConnection
    // left the suite green, because the tenant assertions all called it
    // directly. A handshake that completes against an unexpected tenant must
    // not produce a stored connection.
    const state = encodeState({
      provider: "outlook", workspaceId: owner.workspaceId, userId: owner.ownerId, nonce: FIXED_NONCE,
    });
    const foreign = "11111111-2222-3333-4444-555555555555";
    const before = await db.integration.count({ where: { workspaceId: owner.workspaceId } });
    await assert.rejects(
      () =>
        inContext(owner, () =>
          completeConnection({
            provider: PROVIDERS.outlook,
            code: "any",
            state,
            codeVerifier: "verifier",
            session: session(owner),
            origin: ORIGIN,
            transport: fakeEndpoint(
              microsoftSuccess({
                id_token: idTokenWith(
                  validClaims({
                    tid: foreign,
                    iss: `https://login.microsoftonline.com/${foreign}/v2.0`,
                    preferred_username: "someone@elsewhere.test",
                  }),
                ),
              }),
            ),
          }),
        ),
      /different organisation/i,
      "a token minted by another tenant produced a connection",
    );
    assert.equal(
      await db.integration.count({ where: { workspaceId: owner.workspaceId } }),
      before,
      "a connection was stored despite the tenant mismatch",
    );
  });

  test("a token from the wrong tenant is refused", () => {
    assert.throws(
      () =>
        assertTenant(PROVIDERS.outlook, {
          tid: "11111111-2222-3333-4444-555555555555",
          iss: "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0",
        }),
      /different organisation/i,
      "a token minted by another tenant was accepted",
    );
  });

  test("a token with no tenant claim is refused, not assumed", () => {
    assert.throws(() => assertTenant(PROVIDERS.outlook, { preferred_username: "x@y.test" }), /verified/i);
    assert.throws(() => assertTenant(PROVIDERS.outlook, null), /verified/i);
  });

  test("an issuer that names a different tenant is refused even when tid matches", () => {
    assert.throws(
      () =>
        assertTenant(PROVIDERS.outlook, {
          tid: TENANT,
          iss: "https://login.microsoftonline.com/99999999-0000-0000-0000-000000000000/v2.0",
        }),
      /verified/i,
    );
  });

  test("a consent that declined a permission is refused", async () => {
    // A person can untick individual permissions. Storing the connection anyway
    // gives one that looks healthy and imports nothing.
    const declined = missingScopes(
      PROVIDERS.outlook,
      "openid profile email offline_access https://graph.microsoft.com/User.Read",
    );
    assert.deepEqual(declined, ["https://graph.microsoft.com/Mail.Read"]);

    const state = encodeState({
      provider: "outlook", workspaceId: owner.workspaceId, userId: owner.ownerId, nonce: FIXED_NONCE,
    });
    await assert.rejects(
      () =>
        inContext(owner, () =>
          completeConnection({
            provider: PROVIDERS.outlook,
            code: "any",
            state,
            codeVerifier: verifier,
            session: session(owner),
            origin: ORIGIN,
            transport: fakeEndpoint(
              microsoftSuccess({
                scope: "openid profile email offline_access https://graph.microsoft.com/User.Read",
              }),
            ),
          }),
        ),
      /permissions were not granted/i,
    );
    assert.equal(await db.integration.count({ where: { workspaceId: owner.workspaceId } }), 0);
  });

  test("a response with no refresh token is refused", async () => {
    const state = encodeState({
      provider: "outlook", workspaceId: owner.workspaceId, userId: owner.ownerId, nonce: FIXED_NONCE,
    });
    await assert.rejects(
      () =>
        inContext(owner, () =>
          completeConnection({
            provider: PROVIDERS.outlook,
            code: "any",
            state,
            codeVerifier: verifier,
            session: session(owner),
            origin: ORIGIN,
            transport: fakeEndpoint(microsoftSuccess({ refresh_token: undefined })),
          }),
        ),
      /could not be kept open/i,
    );
  });

  test("the provider's own error text never reaches the customer", async () => {
    const state = encodeState({
      provider: "outlook", workspaceId: owner.workspaceId, userId: owner.ownerId, nonce: FIXED_NONCE,
    });
    try {
      await inContext(owner, () =>
        completeConnection({
          provider: PROVIDERS.outlook,
          code: "any",
          state,
          codeVerifier: verifier,
          session: session(owner),
          origin: ORIGIN,
          transport: fakeEndpoint(
            {
              error: "invalid_client",
              error_description: "AADSTS7000215: Invalid client secret provided. [secret-ish-text]",
            },
            401,
          ),
        }),
      );
      assert.fail("expected a refusal");
    } catch (error) {
      const message = (error as Error).message;
      assert.doesNotMatch(message, /AADSTS|client secret|secret-ish/i,
        "a provider diagnostic reached the customer-facing message");
      assert.match(message, /could not be completed/i);
    }
  });
});

describe("the whole OIDC claim set is checked, not just the tenant", () => {
  /**
   * One test per claim, each starting from a complete and valid set and
   * breaking exactly one thing. `tid` and `iss` alone were what the first
   * version checked, and each of these is a token that passes those two.
   */
  const cases: { claim: string; claims: Record<string, unknown>; expect: RegExp }[] = [
    {
      claim: "audience — minted for a different application",
      claims: { aud: "99999999-0000-0000-0000-000000000000" },
      expect: /is not this client/,
    },
    {
      claim: "audience — absent entirely",
      claims: { aud: undefined },
      expect: /is not this client/,
    },
    {
      claim: "expiry — already expired",
      claims: { exp: Math.floor(Date.now() / 1000) - 600 },
      expect: /expired at/,
    },
    {
      claim: "expiry — no exp claim, so it would never expire",
      claims: { exp: undefined },
      expect: /never expires/,
    },
    {
      claim: "not-before — not yet valid",
      claims: { nbf: Math.floor(Date.now() / 1000) + 600 },
      expect: /not valid before/,
    },
    {
      claim: "issued-at — dated in the future",
      claims: { iat: Math.floor(Date.now() / 1000) + 600 },
      expect: /in the future/,
    },
    {
      claim: "nonce — from a different authorisation attempt",
      claims: { nonce: "a-nonce-from-another-flow" },
      expect: /nonce does not match/,
    },
    {
      claim: "nonce — absent, so the token is bound to nothing",
      claims: { nonce: undefined },
      expect: /carries no nonce/,
    },
  ];

  for (const { claim, claims, expect } of cases) {
    test(`refuses a token whose ${claim}`, async () => {
      const state = encodeState({
        provider: "outlook", workspaceId: owner.workspaceId, userId: owner.ownerId, nonce: FIXED_NONCE,
      });
      const before = await db.integration.count({ where: { workspaceId: owner.workspaceId } });
      let internal = "";
      try {
        await inContext(owner, () =>
          completeConnection({
            provider: PROVIDERS.outlook,
            code: "any",
            state,
            codeVerifier: "verifier",
            session: session(owner),
            origin: ORIGIN,
            transport: fakeEndpoint(
              microsoftSuccess({ id_token: idTokenWith(validClaims(claims)) }),
            ),
          }),
        );
        assert.fail(`a token with a bad ${claim} was accepted`);
      } catch (error) {
        internal = String((error as { internal?: unknown }).internal ?? "");
      }
      assert.match(internal, expect, `the refusal was for the wrong reason: ${internal}`);
      assert.equal(
        await db.integration.count({ where: { workspaceId: owner.workspaceId } }),
        before,
        "a connection was stored despite the refusal",
      );
    });
  }

  test("a complete and valid claim set is accepted", async () => {
    // The control. Without it, every test above would also pass if
    // validateIdTokenClaims simply threw on everything.
    const state = encodeState({
      provider: "outlook", workspaceId: owner.workspaceId, userId: owner.ownerId, nonce: FIXED_NONCE,
    });
    const result = await inContext(owner, () =>
      completeConnection({
        provider: PROVIDERS.outlook,
        code: "any",
        state,
        codeVerifier: "verifier",
        session: session(owner),
        origin: ORIGIN,
        transport: fakeEndpoint(microsoftSuccess()),
      }),
    );
    assert.equal(result.accountEmail, "hello@artifactdigital.co");
    await db.integration.deleteMany({ where: { workspaceId: owner.workspaceId } });
  });
});

describe("replay, and a session that changed mid-flow", () => {
  test("the same callback cannot be completed twice", async () => {
    // The signed state is replayable until it expires — nothing records that
    // it was used — so the single-use verifier cookie is what closes it. This
    // asserts the half that lives in this layer: with the verifier gone, the
    // second attempt is refused before the code is exchanged.
    const state = encodeState({
      provider: "outlook", workspaceId: owner.workspaceId, userId: owner.ownerId, nonce: FIXED_NONCE,
    });
    const complete = (verifier: string | null) =>
      inContext(owner, () =>
        completeConnection({
          provider: PROVIDERS.outlook,
          code: "the-same-code",
          state,
          codeVerifier: verifier,
          session: session(owner),
          origin: ORIGIN,
          transport: fakeEndpoint(microsoftSuccess()),
        }),
      );

    await complete("verifier-present");
    // The route clears the cookie on every exit path, so a replay arrives
    // without it.
    await assert.rejects(() => complete(null), /could not be verified/i);
    assert.equal(
      await db.integration.count({ where: { workspaceId: owner.workspaceId } }),
      1,
      "a replayed callback created a second connection",
    );
    await db.integration.deleteMany({ where: { workspaceId: owner.workspaceId } });
  });

  test("a replay that still has the verifier is refused by the provider, not by us", async () => {
    // Worth being honest about where this boundary is: if a verifier somehow
    // survived, our checks would pass and the *provider* would refuse the
    // second exchange, because an authorisation code is single-use. That is a
    // real defence but it is not ours, so it is asserted as the provider's.
    const state = encodeState({
      provider: "outlook", workspaceId: owner.workspaceId, userId: owner.ownerId, nonce: FIXED_NONCE,
    });
    await assert.rejects(
      () =>
        inContext(owner, () =>
          completeConnection({
            provider: PROVIDERS.outlook,
            code: "already-redeemed",
            state,
            codeVerifier: "verifier",
            session: session(owner),
            origin: ORIGIN,
            transport: fakeEndpoint(
              { error: "invalid_grant", error_description: "AADSTS54005: code already redeemed" },
              400,
            ),
          }),
        ),
      /expired or been revoked/i,
    );
  });

  test("signing in as somebody else mid-flow does not complete the connection", async () => {
    // The person starts the flow, and by the time the provider sends them back
    // the browser holds a different session. The state still verifies — it is
    // correctly signed — so only the session comparison catches this.
    const state = encodeState({
      provider: "outlook", workspaceId: owner.workspaceId, userId: owner.ownerId, nonce: FIXED_NONCE,
    });
    await assert.rejects(
      () =>
        inContext(other, () =>
          completeConnection({
            provider: PROVIDERS.outlook,
            code: "any",
            state,
            codeVerifier: "verifier",
            session: session(other),
            origin: ORIGIN,
            transport: fakeEndpoint(microsoftSuccess()),
          }),
        ),
      /could not be verified/i,
    );
    assert.equal(await db.integration.count({ where: { workspaceId: other.workspaceId } }), 0);
    assert.equal(await db.integration.count({ where: { workspaceId: owner.workspaceId } }), 0);
  });

  test("a state for one provider cannot complete another's callback", async () => {
    const state = encodeState({
      provider: "outlook_calendar", workspaceId: owner.workspaceId, userId: owner.ownerId, nonce: FIXED_NONCE,
    });
    await assert.rejects(
      () =>
        inContext(owner, () =>
          completeConnection({
            provider: PROVIDERS.outlook,
            code: "any",
            state,
            codeVerifier: "verifier",
            session: session(owner),
            origin: ORIGIN,
            transport: fakeEndpoint(microsoftSuccess()),
          }),
        ),
      /could not be verified/i,
    );
  });
});

describe("a successful connection, and ending it", () => {
  test("stores the token encrypted and never in clear", async () => {
    const state = encodeState({
      provider: "outlook", workspaceId: owner.workspaceId, userId: owner.ownerId, nonce: FIXED_NONCE,
    });
    const result = await inContext(owner, () =>
      completeConnection({
        provider: PROVIDERS.outlook,
        code: "any",
        state,
        codeVerifier: "verifier",
        session: session(owner),
        origin: ORIGIN,
        transport: fakeEndpoint(microsoftSuccess()),
      }),
    );
    assert.equal(result.accountEmail, "hello@artifactdigital.co");

    const row = await db.integration.findUniqueOrThrow({
      where: { id: result.integrationId },
      select: { credentials: true, status: true, syncGeneration: true, tokenExpiresAt: true },
    });
    assert.equal(row.status, "connected");
    assert.ok(row.credentials, "no credentials were stored");
    assert.ok(row.credentials!.startsWith("v1.integration-credentials."), "not the encrypted envelope");
    assert.ok(!row.credentials!.includes("fake-access-token"), "the access token is readable in the column");
    assert.ok(!row.credentials!.includes("fake-refresh-token"), "the refresh token is readable in the column");
    assert.equal(row.syncGeneration, 1, "the first connection did not start a generation");
    assert.ok(row.tokenExpiresAt instanceof Date, "no expiry was recorded for refresh scheduling");
  });

  test("reconnecting bumps the generation and resets the backfill", async () => {
    const before = await db.integration.findFirstOrThrow({
      where: { workspaceId: owner.workspaceId },
      select: { id: true, syncGeneration: true },
    });
    await db.integration.update({
      where: { id: before.id },
      data: { syncCursor: "a-cursor-from-the-old-grant", backfillCompletedAt: new Date() },
    });

    const state = encodeState({
      provider: "outlook", workspaceId: owner.workspaceId, userId: owner.ownerId, nonce: FIXED_NONCE,
    });
    await inContext(owner, () =>
      completeConnection({
        provider: PROVIDERS.outlook,
        code: "any",
        state,
        codeVerifier: "verifier",
        session: session(owner),
        origin: ORIGIN,
        transport: fakeEndpoint(microsoftSuccess()),
      }),
    );

    const after = await db.integration.findUniqueOrThrow({
      where: { id: before.id },
      select: { syncGeneration: true, syncCursor: true, backfillCompletedAt: true },
    });
    assert.equal(after.syncGeneration, before.syncGeneration + 1);
    assert.equal(after.syncCursor, null, "a cursor from the previous grant survived a reconnect");
    assert.equal(after.backfillCompletedAt, null, "the backfill was not restarted");
    // And a worker still holding the old generation must stand down.
    assert.equal(await inContext(owner, () => generationIsCurrent(before.id, before.syncGeneration)), false);
    assert.equal(await inContext(owner, () => generationIsCurrent(before.id, after.syncGeneration)), true);
  });

  test("connecting queues the first page and says it is backfilling, not idle", async () => {
    /**
     * The canary caught both halves of this. After a real reconnect the
     * connection sat at `connected / idle`, zero pages, `lastSyncAt` of never:
     *
     *  - `completeConnection` enqueued the first page inline instead of
     *    calling `startBackfill`, leaving `syncState` at `idle` — the same
     *    value a *finished* import has. A queued backfill and a completed one
     *    were indistinguishable in the database and on the Settings page.
     *  - Nothing dispatched the queue, so the job it had just written sat
     *    pending. The comment above it claimed the import started there.
     *
     * This asserts the durable half: the state says backfilling and exactly
     * one job exists, carrying the new generation. Whether a drain then runs
     * promptly is best-effort by design — the cron is the guarantee — so what
     * is pinned here is that there is something for it to find.
     */
    const row = await db.integration.findFirstOrThrow({
      where: { workspaceId: owner.workspaceId },
      select: { id: true, syncGeneration: true },
    });
    await db.domainEvent.deleteMany({ where: { name: "integration.sync", entityId: row.id } });
    await db.integration.update({
      where: { id: row.id },
      data: { syncState: "idle", pagesImported: 7, backfillTruncated: true },
    });

    const state = encodeState({
      provider: "outlook", workspaceId: owner.workspaceId, userId: owner.ownerId, nonce: FIXED_NONCE,
    });
    await inContext(owner, () =>
      completeConnection({
        provider: PROVIDERS.outlook,
        code: "any",
        state,
        codeVerifier: "verifier",
        session: session(owner),
        origin: ORIGIN,
        transport: fakeEndpoint(microsoftSuccess()),
      }),
    );

    const after = await db.integration.findUniqueOrThrow({
      where: { id: row.id },
      select: { syncState: true, syncGeneration: true, pagesImported: true, backfillTruncated: true },
    });
    assert.equal(
      after.syncState,
      "backfilling",
      "a connection with a queued backfill reported a state that a finished one also reports",
    );
    assert.equal(after.pagesImported, 0, "the page budget was not reset for the new attempt");
    assert.equal(after.backfillTruncated, false, "a stale truncation flag survived the reconnect");

    const queued = await db.domainEvent.findMany({
      where: { name: "integration.sync", entityId: row.id },
      select: { payload: true, status: true },
    });
    assert.equal(queued.length, 1, "connecting did not queue exactly one first page");
    // payload is a String column, not Json.
    const payload = JSON.parse(queued[0]!.payload) as { generation?: number; cursor?: string | null };
    assert.equal(
      payload.generation,
      after.syncGeneration,
      "the queued page carries a generation the connection will refuse",
    );
    assert.equal(payload.cursor, null, "the first page of a new grant carried an inherited cursor");
  });

  test("disconnecting destroys the token, bumps the generation, and keeps the data by default", async () => {
    const row = await db.integration.findFirstOrThrow({
      where: { workspaceId: owner.workspaceId },
      select: { id: true, syncGeneration: true },
    });
    await db.emailMessage.create({
      data: {
        workspaceId: owner.workspaceId, provider: "outlook", externalId: "keep-me",
        threadId: "t", subject: "Filed against a deal", snippet: "…",
        fromEmail: "client@example.test", sentAt: new Date(),
        integrationId: row.id, source: "imported", ownerUserId: owner.ownerId, visibility: "private",
      },
    });

    const result = await inContext(owner, () =>
      disconnectConnection({ integrationId: row.id, userId: owner.ownerId, keepImported: true }),
    );
    assert.deepEqual(result, { removedEmails: 0, removedEvents: 0 });

    const after = await db.integration.findUniqueOrThrow({
      where: { id: row.id },
      select: { status: true, credentials: true, tokenExpiresAt: true, syncGeneration: true },
    });
    assert.equal(after.status, "disconnected");
    assert.equal(after.credentials, null, "a token survived a disconnect");
    assert.equal(after.tokenExpiresAt, null);
    assert.equal(after.syncGeneration, row.syncGeneration + 1);
    assert.equal(
      await inContext(owner, () => generationIsCurrent(row.id, row.syncGeneration)),
      false,
      "a queued job could still have imported after a disconnect",
    );
    assert.equal(
      await db.emailMessage.count({ where: { externalId: "keep-me" } }),
      1,
      "imported mail was deleted when the customer asked to keep it",
    );
  });

  test("disconnecting keeps the connection link, so a message still names its mailbox", async () => {
    // The counterpart to the deletion test in integration-privacy.test.ts.
    // A disconnect destroys credentials and keeps the Integration row, so
    // `onDelete: SetNull` does not fire and `integrationId` survives. Asserted
    // because the code comment once claimed the opposite, and a real
    // disconnect against the canary is what proved it wrong.
    const row = await db.integration.findFirstOrThrow({
      where: { workspaceId: owner.workspaceId },
      select: { id: true },
    });
    const kept = await db.emailMessage.findFirstOrThrow({
      where: { externalId: "keep-me" },
      select: { integrationId: true, source: true, visibility: true, ownerUserId: true },
    });
    assert.equal(kept.integrationId, row.id, "the connection link was released by a disconnect");
    assert.equal(kept.source, "imported", "provenance was lost");
    assert.equal(kept.visibility, "private", "a kept message became workspace-visible");
    assert.equal(kept.ownerUserId, owner.ownerId, "ownership was lost");

    // And the Integration row itself is still there, holding no credentials.
    const connection = await db.integration.findUniqueOrThrow({
      where: { id: row.id },
      select: { status: true, credentials: true },
    });
    assert.equal(connection.status, "disconnected");
    assert.equal(connection.credentials, null, "a credential survived the disconnect");
  });

  test("disconnecting with keepImported false removes exactly that connection's data", async () => {
    const row = await db.integration.findFirstOrThrow({
      where: { workspaceId: owner.workspaceId },
      select: { id: true },
    });
    // A row from somewhere else, which must survive.
    await db.emailMessage.create({
      data: {
        workspaceId: owner.workspaceId, provider: "mock", externalId: "seeded-survivor",
        threadId: "t2", subject: "Seeded", snippet: "…",
        fromEmail: "demo@example.test", sentAt: new Date(), source: "seed",
      },
    });
    const result = await inContext(owner, () =>
      disconnectConnection({ integrationId: row.id, userId: owner.ownerId, keepImported: false }),
    );
    assert.equal(result.removedEmails, 1, "the connection's own imported mail was not removed");
    assert.equal(await db.emailMessage.count({ where: { externalId: "keep-me" } }), 0);
    assert.equal(
      await db.emailMessage.count({ where: { externalId: "seeded-survivor" } }),
      1,
      "data from another source was deleted",
    );
  });

  test("another person cannot disconnect my connection", async () => {
    const mine = await db.integration.findFirstOrThrow({
      where: { workspaceId: owner.workspaceId },
      select: { id: true },
    });
    await assert.rejects(
      () =>
        inContext(other, () =>
          disconnectConnection({ integrationId: mine.id, userId: other.ownerId, keepImported: true }),
        ),
      /does not exist/i,
      "a connection was disconnectable by someone who does not own it",
    );
  });
});
