import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { SECRETS, realisticStack, plainStack } from "../helpers/leak-fixtures";

/**
 * The scrubbing tests check the functions. This one checks the bytes.
 *
 * The leak was not in a scrubbing function — both did what they said. It was in
 * the *assembly*: `exception.values[0].value` received the scrubbed message and
 * `logentry.formatted` received the stack, which begins with the unscrubbed
 * one. Every test that examined a function in isolation passed while a database
 * password, a webhook URL, an API key, a session token and the text of a CRM
 * note were leaving the process.
 *
 * So this drives the real adapter through a stubbed transport and asserts on
 * the serialized request body — the only representation that cannot disagree
 * with what Sentry receives. A field added to the payload later is covered
 * automatically; a per-function test would not have been.
 *
 * It lives in its own file because the adapter is chosen once, at module load,
 * from `SENTRY_DSN`. Any static import of `observability` — even for an
 * unrelated helper — pins it to the log adapter before the test can set a DSN,
 * and the assertions then silently examine a request that was never made.
 */
describe("the outbound Sentry request carries no secrets", () => {
  const originalFetch = globalThis.fetch;

  async function capturedBody(
    context?: { route?: string; operation?: string },
    stack: string = realisticStack,
  ): Promise<string> {
    let body = "";
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      body = String(init.body);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    process.env.SENTRY_DSN = "https://0123456789abcdef0123456789abcdef@o1.ingest.sentry.io/2";
    const { captureError } = await import("../../src/lib/observability");

    const error = new Error(stack.split("\n")[0]!);
    error.stack = stack;
    try {
      await captureError(error, {
        operation: "contact.list",
        ...context,
        // `note` is content, not an identifier. `redact` matches key names and
        // cannot know that — the content scrub and length cap are what stop it.
        tags: { note: SECRETS.note, email: SECRETS.email } as never,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    return body;
  }

  test("no secret of any category appears anywhere in the request body", async () => {
    const body = await capturedBody();
    assert.ok(body.length > 0, "the adapter sent no request at all");
    for (const [label, secret] of Object.entries(SECRETS)) {
      assert.ok(!body.includes(secret), `${label} was sent to Sentry:\n${body}`);
    }
  });

  test("the request is still worth sending", async () => {
    // The other direction: a payload scrubbed into uselessness satisfies every
    // leak assertion above. An unactionable report is its own failure.
    const body = await capturedBody();
    assert.match(body, /contacts\.ts/, `the failing file never reached Sentry:\n${body}`);
    assert.match(body, /contact\.list/, `the operation never reached Sentry:\n${body}`);
  });

  test("a query string never reaches the provider", async () => {
    // Next hands `onRequestError` a path *with the query string attached* —
    // documented as "resource path, e.g. /blog?name=foo". This application
    // serves /api/search?q=..., and that route is known to be able to throw, so
    // the transaction name was carrying the user's search term: the names of
    // the contacts and companies they were looking for.
    //
    // Enforced at the sink rather than at the call site, so no future caller
    // can reintroduce it by passing a raw path.
    const body = await capturedBody({
      route: "/api/search?q=Acme%20Corporation&owner=britt%40tinycrm.biz",
      operation: "GET",
    });
    assert.ok(!body.includes("Acme"), `a search term was sent to Sentry:\n${body}`);
    assert.ok(!body.includes("q="), `a query string was sent to Sentry:\n${body}`);
    assert.match(body, /\/api\/search/, `the route itself was lost:\n${body}`);
  });

  test("the event carries an id we chose, so a report is traceable from our logs", async () => {
    // Sentry accepts a client-supplied event_id and uses it as the event's own
    // id. Generating it here rather than reading it back from the response
    // means a log line can name the exact Sentry event without the adapter
    // ever parsing a response body — which it deliberately does not do, since
    // that body can echo the payload back.
    //
    // Without this an accepted report is unfindable: the dashboard has an
    // event, the logs have a request, and nothing connects them.
    const body = await capturedBody();
    const eventId = JSON.parse(body).event_id;
    assert.match(
      String(eventId),
      /^[0-9a-f]{32}$/,
      `event_id is missing or not in Sentry's required form: ${eventId}`,
    );
  });

  test("two reports do not share an event id", async () => {
    const a = JSON.parse(await capturedBody()).event_id;
    const b = JSON.parse(await capturedBody()).event_id;
    assert.notEqual(a, b, "every report would collapse onto one event");
  });

  test("a non-Prisma error leaks nothing either", async () => {
    // The Prisma-shaped fixture masked two real leaks: its rule spans to the
    // first stack frame, so it removed everything before any other rule ran.
    // This sends the same secrets behind a plain TypeError, over the wire.
    const body = await capturedBody(undefined, plainStack);
    for (const [label, secret] of Object.entries(SECRETS)) {
      assert.ok(!body.includes(secret), `${label} was sent to Sentry:\n${body}`);
    }
    assert.match(body, /contacts\.ts/, `the failing file never reached Sentry:\n${body}`);
  });

  test("no field capable of carrying an IP address or a location is ever sent", async () => {
    // Sentry's UI showed "Geography: Ashburn, United States" under Contexts →
    // User for an event this application triggered, which read as though we had
    // transmitted a location. We had not: the event carried no `user` key at
    // all, and Ashburn is where the Vercel function runs (x-vercel-id reported
    // execution region iad1), not where the caller was — the caller's nearest
    // edge on that same request was sfo1. Sentry infers the IP of whatever
    // connection submits the event, so what it geolocated was our own server.
    //
    // This locks the property that made that conclusion possible: the payload
    // is an allowlist, and none of the fields Sentry would read a person's
    // location out of are in it. Without this a later field addition could
    // start transmitting one and the UI would look exactly the same.
    const body = await capturedBody();
    for (const field of ["ip_address", "geo", "request", "server_name", "contexts", "breadcrumbs", "threads", "modules"]) {
      assert.ok(!body.includes(`"${field}"`), `${field} is being transmitted:\n${body}`);
    }
  });

  test("the user object carries an id and nothing else", async () => {
    const body = await capturedBody({ route: "/contacts/[id]", operation: "GET" });
    const { user } = JSON.parse(body);
    // Unauthenticated errors send no user at all; authenticated ones send only
    // an id. Either is fine — anything *else* in there is not.
    if (user !== undefined) {
      assert.deepEqual(Object.keys(user), ["id"], `the user object grew a field: ${JSON.stringify(user)}`);
    }
  });
});
