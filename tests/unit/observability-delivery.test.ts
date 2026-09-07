import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

/**
 * A report that never arrives must not look like one that did.
 *
 * The Sentry adapter awaited `fetch` inside a try/catch, which catches a
 * network failure — and nothing else. `fetch` does not throw on 4xx or 5xx, so
 * a rejected event (429 rate limited, 413 too large, 401 bad key, 410 endpoint
 * retired) returned normally and the adapter carried on as though the error had
 * been reported.
 *
 * That is the failure mode that matters most for observability: the dashboard
 * is empty, the application believes it is reporting, and nobody finds out
 * until an incident that leaves no trace. Found while checking whether the
 * legacy /store/ endpoint still accepts events — it does, but the silence would
 * have hidden the day it stops.
 */

const originalFetch = globalThis.fetch;
const originalError = console.error;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalError;
});

async function captureWith(response: Response | Error): Promise<string[]> {
  const lines: string[] = [];
  console.error = (line: unknown) => { lines.push(String(line)); };
  globalThis.fetch = (async () => {
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;

  process.env.SENTRY_DSN = "https://0123456789abcdef0123456789abcdef@o1.ingest.sentry.io/2";
  const { captureError } = await import("../../src/lib/observability");
  await captureError(new Error("probe failure"), { operation: "test.probe" });
  return lines;
}

describe("observability delivery failures are never silent", () => {
  test("a rejected event is reported, not swallowed", async () => {
    const lines = await captureWith(new Response("rate limited", { status: 429 }));
    assert.ok(
      lines.some((l) => /could not report an exception|rejected/i.test(l)),
      `a 429 from the error sink produced no log line: ${JSON.stringify(lines)}`,
    );
  });

  test("the status code is recorded, so the cause is diagnosable", async () => {
    const lines = await captureWith(new Response("gone", { status: 410 }));
    assert.ok(
      lines.some((l) => l.includes("410")),
      `the rejection did not record its status: ${JSON.stringify(lines)}`,
    );
  });

  test("a transport failure is still reported", async () => {
    const lines = await captureWith(new TypeError("fetch failed"));
    assert.ok(
      lines.some((l) => /could not report an exception/i.test(l)),
      `a network failure produced no log line: ${JSON.stringify(lines)}`,
    );
  });

  test("a successful send logs nothing", async () => {
    // Over-logging a working sink is its own problem: it trains people to
    // ignore the line that matters.
    const lines = await captureWith(new Response(JSON.stringify({ id: "abc" }), { status: 200 }));
    assert.equal(
      lines.filter((l) => /could not report an exception/i.test(l)).length,
      0,
      `a successful send logged a failure: ${JSON.stringify(lines)}`,
    );
  });
});
