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
