import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { adapterKindFor } from "../../src/lib/mail";

/**
 * The rule that decides whether mail actually goes anywhere.
 *
 * Extracted from `selectAdapter` so the notice preflight can ask "would
 * this configuration reach the real provider?" without importing the module
 * for its side effect — the adapter is chosen once at load from whatever
 * the environment held at that moment. These pin the rule itself, because
 * it is now load-bearing in two places.
 */
describe("which mail adapter a configuration selects", () => {
  test("a URL and a token select the real provider", () => {
    assert.equal(adapterKindFor("https://api.example/emails", "tok", { production: true }), "http");
    assert.equal(adapterKindFor("https://api.example/emails", "tok", { production: false }), "http");
  });

  test("production without a provider falls to the log adapter, never the sink", () => {
    // The sink silently swallows mail and reports success. In production
    // that is indistinguishable from delivery, which is the whole reason
    // the sink is unreachable there.
    assert.equal(adapterKindFor(undefined, undefined, { production: true }), "log");
    assert.equal(adapterKindFor("https://api.example/emails", undefined, { production: true }), "log");
    assert.equal(adapterKindFor(undefined, "tok", { production: true }), "log");
    assert.equal(
      adapterKindFor(undefined, undefined, { production: true, configured: "sink" }),
      "log",
      "MAIL_ADAPTER=sink must not reach the sink in production",
    );
  });

  test("development without a provider uses the sink unless told to log", () => {
    assert.equal(adapterKindFor(undefined, undefined, { production: false }), "sink");
    assert.equal(adapterKindFor(undefined, undefined, { production: false, configured: "log" }), "log");
  });

  test("an empty token is not a token", () => {
    // The exact shape production was in: the variable present, the value
    // empty. A truthiness check is what makes that fall through correctly.
    assert.equal(adapterKindFor("https://api.example/emails", "", { production: true }), "log");
    assert.equal(adapterKindFor("", "tok", { production: true }), "log");
  });
});
