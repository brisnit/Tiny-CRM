import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Tenant isolation on a multi-tenant authority.
 *
 * Widening the authority from one tenant to `organizations` removes the
 * single value every token used to be compared against. The isolation it
 * provided must not go with it: the rule becomes per connection, and the
 * failure to guard against is "accept anything that completes the
 * handshake".
 *
 * Each mode runs in its own process. `MICROSOFT_TENANT_ID` is read when
 * `env.ts` is first evaluated, so flipping it between cases in one process
 * changes nothing — an earlier version of this file did that and reported
 * pinned mode as broken when it was the test that was.
 */
const PINNED = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

/** Runs the assertions below with MICROSOFT_TENANT_ID set to `tenant`. */
function inMode(tenant: string, body: string) {
  const script = `(async () => {
    const { assertTenant } = await import("./src/lib/integrations/oauth-client.ts");
    const outlook = { id: "outlook", vendor: "microsoft" };
    const PINNED = ${JSON.stringify(PINNED)};
    const OTHER = ${JSON.stringify(OTHER)};
    const claims = (tid, iss) => ({ tid, iss: iss ?? (tid ? "https://login.microsoftonline.com/" + tid + "/v2.0" : undefined) });
    const threw = (fn) => { try { fn(); return null; } catch (e) { return String(e.message ?? e); } };
    const out = {};
    ${body}
    console.log(JSON.stringify(out));
  })().catch((e) => { console.error(e); process.exit(1); });`;

  const run = spawnSync("npx", ["tsx", "--eval", script], {
    cwd: resolve(import.meta.dirname, "../.."),
    encoding: "utf8",
    env: {
      ...process.env,
      MICROSOFT_TENANT_ID: tenant,
      NODE_OPTIONS: "--require ./scripts/allow-server-modules.cjs",
    },
  });
  const line = (run.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
  assert.ok(line, `no result from the subprocess:\n${run.stdout}\n${run.stderr}`);
  return JSON.parse(line) as Record<string, string | null>;
}

describe("multi-tenant Outlook keeps tenants apart", () => {
  test("organizations: first connection allowed, foreign takeover refused", () => {
    const r = inMode("organizations", `
      out.first = threw(() => assertTenant(outlook, claims(OTHER), { expectedTenant: null }));
      out.same = threw(() => assertTenant(outlook, claims(PINNED), { expectedTenant: PINNED }));
      out.foreign = threw(() => assertTenant(outlook, claims(OTHER), { expectedTenant: PINNED }));
      out.noTid = threw(() => assertTenant(outlook, claims(undefined), { expectedTenant: null }));
      out.issuerLies = threw(() => assertTenant(outlook,
        { tid: OTHER, iss: "https://login.microsoftonline.com/" + PINNED + "/v2.0" },
        { expectedTenant: null }));
    `);

    assert.equal(r.first, null, "a first connection from any work tenant must be allowed");
    assert.equal(r.same, null, "the same tenant reconnecting must be allowed");

    // The isolation property: a re-consent is not a transfer. Somebody who
    // can complete a handshake in their own tenant must not take over a
    // connection belonging to another organisation.
    assert.match(String(r.foreign), /different organisation/i,
      "a token from another tenant was accepted for an existing connection");

    // Widening the authority must not become "accept anything that completes".
    assert.match(String(r.noTid), /could not be verified/i,
      "a token with no tenant claim was accepted");

    assert.match(String(r.issuerLies), /could not be verified/i,
      "a token whose issuer and tid disagree was accepted");
  });

  test("pinned: unchanged, and the pin governs over any recorded value", () => {
    const r = inMode(PINNED, `
      out.foreign = threw(() => assertTenant(outlook, claims(OTHER), { expectedTenant: null }));
      out.own = threw(() => assertTenant(outlook, claims(PINNED), {}));
      out.recordedDisagrees = threw(() => assertTenant(outlook, claims(OTHER), { expectedTenant: OTHER }));
    `);

    assert.match(String(r.foreign), /different organisation/i,
      "pinning stopped working when multi-tenant was added");
    assert.equal(r.own, null, "the configured tenant was refused");
    // Defence in depth: a row carrying another tenant must not override the pin.
    assert.match(String(r.recordedDisagrees), /different organisation/i,
      "a recorded tenant overrode the configured pin");
  });
});
