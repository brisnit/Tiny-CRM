import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * The diagnostics endpoint manufactures error reports on demand, which makes it
 * a way to exhaust an error-tracking quota and bury real incidents under noise.
 * It is public-routable — API routes bypass the proxy in src/proxy.ts — so the
 * secret is the only thing standing in front of it.
 *
 * These assert the gate, not the throwing: that unauthenticated and
 * wrong-secret callers are turned away *without* an event being generated, and
 * that a caller cannot write arbitrary text into the error stream through the
 * correlation nonce.
 */

const ROUTE = "../../src/app/api/diagnostics/error/route";
const secret = "test-cron-secret-value";

async function post(headers: Record<string, string>) {
  process.env.CRON_SECRET = secret;
  const { POST } = await import(ROUTE);
  return POST(new Request("https://example.test/api/diagnostics/error", { method: "POST", headers }));
}

describe("the diagnostics error endpoint is not an open error generator", () => {
  test("an unauthenticated caller gets 401 and generates no event", async () => {
    const response = await post({});
    assert.equal(response.status, 401, "an unauthenticated caller was not rejected");
    assert.deepEqual(await response.json(), { ok: false }, "the rejection leaked detail");
  });

  test("a wrong secret gets 401", async () => {
    const response = await post({ authorization: "Bearer not-the-secret-at-all" });
    assert.equal(response.status, 401, "a wrong secret was accepted");
  });

  test("a bearer of the right length but wrong value is still rejected", async () => {
    // Guards the constant-time comparison against being replaced by a length
    // check, which would accept anything of the correct size.
    const wrong = "x".repeat(secret.length);
    const response = await post({ authorization: `Bearer ${wrong}` });
    assert.equal(response.status, 401, "a same-length wrong secret was accepted");
  });

  test("an authorized caller throws, so the error takes the real reporting path", async () => {
    await assert.rejects(
      () => post({ authorization: `Bearer ${secret}` }),
      /observability pipeline verification/,
      "the endpoint did not raise the exception it exists to raise",
    );
  });

  test("the correlation nonce cannot carry arbitrary text into the error stream", async () => {
    // Whatever this echoes is about to be sent to a third party. A free-text
    // field here would be a way to write into that stream through an
    // application that otherwise refuses to.
    await assert.rejects(
      () => post({
        authorization: `Bearer ${secret}`,
        "x-diagnostic-nonce": "note: client is unhappy about pricing",
      }),
      (error: Error) => {
        assert.ok(!error.message.includes("unhappy"), `injected text reached the error: ${error.message}`);
        assert.match(error.message, /unlabelled/, "a rejected nonce was not replaced");
        return true;
      },
    );
  });

  test("a well-formed nonce is preserved, so a triggered event can be found", async () => {
    await assert.rejects(
      () => post({ authorization: `Bearer ${secret}`, "x-diagnostic-nonce": "a1b2c3d4" }),
      /a1b2c3d4/,
      "the correlation nonce was lost, making the event unfindable",
    );
  });
});
