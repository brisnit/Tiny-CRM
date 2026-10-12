/**
 * Sets the Microsoft canary identifiers **before** anything reads them.
 *
 * `src/lib/env.ts` builds its object once, at module load, and
 * `src/lib/integrations/providers.ts` computes the authority URLs from it at
 * load too. Setting `process.env` in a `before()` hook is therefore too late:
 * ES module imports are hoisted and evaluated first, so the modules under test
 * have already captured whatever was there.
 *
 * Importing this file *first* works because ESM evaluates imports in order, so
 * its side effect runs before the later imports' bodies do. That is a real
 * constraint of the design rather than a trick: an environment-derived constant
 * cannot be changed after the fact, and pretending otherwise produced a suite
 * where fifteen of eighteen tests failed with "That connection is not
 * available right now".
 *
 * The client id and tenant id are the canary's real ones — they are
 * identifiers, not secrets, and they appear in every authorisation URL. The
 * secret is deliberately fake: every test in this suite talks to a mocked token
 * endpoint and must never reach a real provider.
 */
process.env.MICROSOFT_CLIENT_ID ??= "080880ad-f468-4e83-bf08-b117e13deba5";
process.env.MICROSOFT_TENANT_ID ??= "4883aac4-8e9b-42fe-a7cf-78b9183ddc99";
// Overwritten rather than defaulted: if a real secret is present in a local
// `.env`, a test must not use it.
process.env.MICROSOFT_CLIENT_SECRET = "fake-secret-for-tests";

export const CANARY_TENANT_ID = process.env.MICROSOFT_TENANT_ID;
export const CANARY_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
