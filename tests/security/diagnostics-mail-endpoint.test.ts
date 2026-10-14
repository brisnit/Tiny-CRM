import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * The mail diagnostics endpoint sends real email from the production sender.
 *
 * That makes it two things worth guarding: a way to send mail as us, and — if
 * the recipient were ever caller-controlled — an open relay behind a single
 * environment variable. It is public-routable, because API routes bypass
 * src/proxy.ts, so the secret is the only thing in front of it.
 *
 * These assert the gate and the fixed recipient. The recipient test is the
 * important one: it is not checking today's behaviour so much as making the
 * day somebody adds `?to=` a day the suite goes red.
 */

const ROUTE = "../../src/app/api/diagnostics/mail/route";
const secret = "test-cron-secret-value";

const sent: { to: string; subject: string; text?: string }[] = [];
const originalFetch = globalThis.fetch;

/** Stand in for the provider so nothing leaves the machine. */
function captureProvider() {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: "re_test_id" }), { status: 200 });
  }) as typeof fetch;
}

async function post(headers: Record<string, string>, { provider = true } = {}) {
  process.env.CRON_SECRET = secret;
  if (provider) {
    process.env.MAIL_PROVIDER_URL = "https://api.example.test/emails";
    process.env.MAIL_PROVIDER_TOKEN = "token-not-a-real-one";
    process.env.MAIL_FROM = "Tiny CRM <no-reply@tinycrm.test>";
  } else {
    delete process.env.MAIL_PROVIDER_URL;
    delete process.env.MAIL_PROVIDER_TOKEN;
  }
  captureProvider();
  const { POST } = await import(ROUTE);
  return POST(
    new Request("https://example.test/api/diagnostics/mail", { method: "POST", headers }),
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  sent.length = 0;
});

describe("the mail diagnostics endpoint is not an open relay", () => {
  test("an unauthenticated caller gets 401 and nothing is sent", async () => {
    const response = await post({});
    assert.equal(response.status, 401, "an unauthenticated caller was not rejected");
    assert.deepEqual(await response.json(), { ok: false }, "the rejection leaked detail");
    assert.equal(sent.length, 0, "a message was sent to an unauthenticated caller");
  });

  test("a wrong secret gets 401 and nothing is sent", async () => {
    const response = await post({ authorization: "Bearer not-the-secret-at-all" });
    assert.equal(response.status, 401);
    assert.equal(sent.length, 0);
  });

  test("a bearer of the right length but wrong value is still rejected", async () => {
    // Guards the constant-time comparison against being replaced by a length
    // check, which would accept anything of the correct size.
    const response = await post({ authorization: `Bearer ${"x".repeat(secret.length)}` });
    assert.equal(response.status, 401, "a same-length wrong secret was accepted");
    assert.equal(sent.length, 0);
  });

  test("the recipient is fixed, and no input can redirect it", async () => {
    /**
     * The property that keeps this from being a relay. The request below
     * tries every channel an endpoint like this usually reads from — query
     * string, headers, and a JSON body — and the message must still go to
     * the address compiled into the route.
     */
    process.env.CRON_SECRET = secret;
    process.env.MAIL_PROVIDER_URL = "https://api.example.test/emails";
    process.env.MAIL_PROVIDER_TOKEN = "token-not-a-real-one";
    process.env.MAIL_FROM = "Tiny CRM <no-reply@tinycrm.test>";
    captureProvider();
    const { POST } = await import(ROUTE);

    const response = await POST(
      new Request("https://example.test/api/diagnostics/mail?to=attacker@evil.test", {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "x-to": "attacker@evil.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ to: "attacker@evil.test", recipient: "attacker@evil.test" }),
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(sent.length, 1, "exactly one message should be sent");
    assert.deepEqual(sent[0].to, ["privacy@tinycrm.biz"], "the recipient was redirected");

    const body = await response.json();
    assert.equal(body.to, "privacy@tinycrm.biz");
    assert.equal(body.ok, true);
    assert.equal(body.providerMessageId, "re_test_id");
  });

  test("the body carries no caller-supplied text", async () => {
    const response = await post({ authorization: `Bearer ${secret}` });
    assert.equal(response.status, 200);
    assert.match(sent[0].subject, /mail configuration test/i);
    assert.match(String(sent[0].text), /contains no customer data/);
  });

  test("it is rate limited, and the cap is small", async () => {
    /**
     * CRON_SECRET is a long-lived environment variable. If it leaks, the
     * thing on the other side is outbound mail to a fixed inbox, so the
     * secret alone is not a sufficient control: without a cap, one leaked
     * value is an unbounded flood at our own privacy contact and at the
     * provider quota.
     *
     * Run in a fresh process so the limiter's counters start empty and are
     * not shared with whatever else the suite has already counted.
     */
    const script = `(async () => {
      process.env.CRON_SECRET = ${JSON.stringify(secret)};
      process.env.MAIL_PROVIDER_URL = "https://api.example.test/emails";
      process.env.MAIL_PROVIDER_TOKEN = "token-not-a-real-one";
      process.env.MAIL_FROM = "Tiny CRM <no-reply@tinycrm.test>";
      let sends = 0;
      globalThis.fetch = async () => {
        sends += 1;
        return new Response(JSON.stringify({ id: "re_test" }), { status: 200 });
      };
      const { POST } = await import("./src/app/api/diagnostics/mail/route.ts");
      const statuses = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await POST(new Request("https://example.test/api/diagnostics/mail", {
          method: "POST",
          headers: { authorization: "Bearer " + process.env.CRON_SECRET, "x-forwarded-for": "203.0.113.9" },
        }));
        statuses.push(res.status);
      }
      console.log(JSON.stringify({ statuses, sends }));
    })().catch((e) => { console.error(e); process.exit(1); });`;
    const run = spawnSync("npx", ["tsx", "--eval", script], {
      cwd: resolve(import.meta.dirname, "../.."),
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "--require ./scripts/allow-server-modules.cjs" },
    });
    const line = (run.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
    assert.ok(line, `no result from the subprocess:\n${run.stdout}\n${run.stderr}`);
    const { statuses, sends } = JSON.parse(line);

    assert.ok(
      statuses.includes(429),
      `six calls in a row were never refused — is the limiter wired up? ${JSON.stringify(statuses)}`,
    );
    assert.ok(sends <= 3, `the cap let ${sends} messages through; it should be at most 3`);
    assert.equal(statuses[0], 200, "the first call should succeed");
  });

  test("the 429 carries retry-after, so a caller is told how long", async () => {
    const script = `(async () => {
      process.env.CRON_SECRET = ${JSON.stringify(secret)};
      process.env.MAIL_PROVIDER_URL = "https://api.example.test/emails";
      process.env.MAIL_PROVIDER_TOKEN = "token-not-a-real-one";
      process.env.MAIL_FROM = "Tiny CRM <no-reply@tinycrm.test>";
      globalThis.fetch = async () => new Response(JSON.stringify({ id: "re_test" }), { status: 200 });
      const { POST } = await import("./src/app/api/diagnostics/mail/route.ts");
      let last;
      for (let i = 0; i < 6; i += 1) {
        last = await POST(new Request("https://example.test/api/diagnostics/mail", {
          method: "POST",
          headers: { authorization: "Bearer " + process.env.CRON_SECRET, "x-forwarded-for": "203.0.113.10" },
        }));
      }
      console.log(JSON.stringify({ status: last.status, retryAfter: last.headers.get("retry-after") }));
    })().catch((e) => { console.error(e); process.exit(1); });`;
    const run = spawnSync("npx", ["tsx", "--eval", script], {
      cwd: resolve(import.meta.dirname, "../.."),
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "--require ./scripts/allow-server-modules.cjs" },
    });
    const line = (run.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
    assert.ok(line, `no result:\n${run.stdout}\n${run.stderr}`);
    const { status, retryAfter } = JSON.parse(line);
    assert.equal(status, 429);
    assert.ok(Number(retryAfter) > 0, `retry-after was ${JSON.stringify(retryAfter)}`);
  });

  test("an unauthenticated flood does not consume the operator's budget", async () => {
    /**
     * The ordering the limiter depends on. If the cap were counted before
     * the secret check, anyone could exhaust it from outside and lock the
     * operator out of their own diagnostic — a denial of service handed
     * over for free. Unauthenticated callers send no mail, so they are not
     * the thing being rationed.
     */
    const script = `(async () => {
      process.env.CRON_SECRET = ${JSON.stringify(secret)};
      process.env.MAIL_PROVIDER_URL = "https://api.example.test/emails";
      process.env.MAIL_PROVIDER_TOKEN = "token-not-a-real-one";
      process.env.MAIL_FROM = "Tiny CRM <no-reply@tinycrm.test>";
      globalThis.fetch = async () => new Response(JSON.stringify({ id: "re_test" }), { status: 200 });
      const { POST } = await import("./src/app/api/diagnostics/mail/route.ts");
      const call = (headers) => POST(new Request("https://example.test/api/diagnostics/mail", {
        method: "POST", headers: { "x-forwarded-for": "203.0.113.11", ...headers },
      }));
      for (let i = 0; i < 20; i += 1) await call({ authorization: "Bearer wrong-secret-value" });
      const res = await call({ authorization: "Bearer " + process.env.CRON_SECRET });
      console.log(JSON.stringify({ status: res.status }));
    })().catch((e) => { console.error(e); process.exit(1); });`;
    const run = spawnSync("npx", ["tsx", "--eval", script], {
      cwd: resolve(import.meta.dirname, "../.."),
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "--require ./scripts/allow-server-modules.cjs" },
    });
    const line = (run.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
    assert.ok(line, `no result:\n${run.stdout}\n${run.stderr}`);
    assert.equal(
      JSON.parse(line).status,
      200,
      "twenty unauthenticated calls exhausted the operator's rate limit",
    );
  });

  test("the Authorization header never reaches a log", async () => {
    /**
     * Asserted on the whole log stream rather than on the route's own calls,
     * because the route is not the only thing that logs during a request.
     * The secret is distinctive, so searching for it is exact.
     */
    const script = `(async () => {
      process.env.CRON_SECRET = ${JSON.stringify(secret)};
      process.env.MAIL_PROVIDER_URL = "https://api.example.test/emails";
      process.env.MAIL_PROVIDER_TOKEN = "token-not-a-real-one";
      process.env.MAIL_FROM = "Tiny CRM <no-reply@tinycrm.test>";
      // A rejection, because the failure paths are where detail usually leaks.
      globalThis.fetch = async () => new Response("no", { status: 403 });
      const { POST } = await import("./src/app/api/diagnostics/mail/route.ts");
      await POST(new Request("https://example.test/api/diagnostics/mail", {
        method: "POST",
        headers: { authorization: "Bearer " + process.env.CRON_SECRET, "x-forwarded-for": "203.0.113.12" },
      }));
    })().catch((e) => { console.error(e); process.exit(1); });`;
    const run = spawnSync("npx", ["tsx", "--eval", script], {
      cwd: resolve(import.meta.dirname, "../.."),
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "--require ./scripts/allow-server-modules.cjs" },
    });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    assert.ok(output.length > 0, "the subprocess produced no output at all, so this proved nothing");
    assert.doesNotMatch(output, /test-cron-secret-value/, "the secret appeared in the log stream");
    assert.doesNotMatch(output, /authorization/i, "an authorization header was logged");
    // And the rejection WAS logged, so the absence above is not silence.
    assert.match(output, /mail provider rejected a message/, "the rejection was not logged at all");
  });

  test("it refuses when the real provider is not selected", () => {
    /**
     * A success against the development sink looks exactly like proof and is
     * not proof, which is the whole failure mode this endpoint exists for.
     *
     * In a fresh process, because `src/lib/mail.ts` selects its adapter once
     * at module load and caches it on globalThis. Flipping the environment
     * variables mid-suite changes nothing — the first import in the process
     * already decided. An earlier version of this test did exactly that and
     * failed, which is the adapter behaving correctly and the test being
     * wrong.
     */
    // Wrapped in an async IIFE: `tsx --eval` compiles as CommonJS, where
    // top-level await is a build error rather than a runtime one.
    const script = `(async () => {
      process.env.CRON_SECRET = ${JSON.stringify(secret)};
      delete process.env.MAIL_PROVIDER_URL;
      delete process.env.MAIL_PROVIDER_TOKEN;
      globalThis.fetch = async () => { throw new Error("the provider was contacted"); };
      const { POST } = await import("./src/app/api/diagnostics/mail/route.ts");
      const res = await POST(new Request("https://example.test/api/diagnostics/mail", {
        method: "POST", headers: { authorization: "Bearer " + process.env.CRON_SECRET },
      }));
      console.log(JSON.stringify({ status: res.status, body: await res.json() }));
    })().catch((e) => { console.error(e); process.exit(1); });`;
    const run = spawnSync("npx", ["tsx", "--eval", script], {
      cwd: resolve(import.meta.dirname, "../.."),
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "--require ./scripts/allow-server-modules.cjs" },
    });
    const line = (run.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
    assert.ok(line, `no result from the subprocess:\n${run.stdout}\n${run.stderr}`);
    const { status, body } = JSON.parse(line);
    assert.equal(status, 503, "a send was attempted without the real provider");
    assert.equal(body.ok, false);
    assert.match(body.error, /prove nothing/);
  });

  test("a provider rejection is reported as a failure, not a success", async () => {
    process.env.CRON_SECRET = secret;
    process.env.MAIL_PROVIDER_URL = "https://api.example.test/emails";
    process.env.MAIL_PROVIDER_TOKEN = "token-not-a-real-one";
    process.env.MAIL_FROM = "Tiny CRM <no-reply@tinycrm.test>";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "domain not verified" }), {
        status: 403,
      })) as typeof fetch;

    const { POST } = await import(ROUTE);
    const response = await POST(
      new Request("https://example.test/api/diagnostics/mail", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
      }),
    );

    assert.equal(response.status, 502, "a refused message was reported as 2xx");
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.match(String(body.error), /403/, "the provider's status was not reported");
  });
});
