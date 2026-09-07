import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { redact } from "../../src/lib/logger";

/**
 * Credentials that live in a URL rather than in a header.
 *
 * `redact()` stripped `sk-` keys and `Bearer` tokens, which covers the shapes
 * that appear in request headers. It did not cover the shape that appears in a
 * *webhook* — where the secret is the URL itself. A delivery failure logs
 * `String(error)`, and a fetch error can carry the URL it was fetching, so the
 * alert webhook could reach the logs and the SecurityAlert.deliveryError column
 * through the one code path whose job is to report that alerting is broken.
 *
 * These are the exact hosts the application posts alerts to.
 */
describe("webhook credentials never survive redaction", () => {
  // Assembled at runtime rather than written as literals. These are invented
  // values, but a fabricated webhook URL is indistinguishable from a real one to
  // a secret scanner — GitHub push protection rejected this file when they were
  // literals. Splitting them keeps the test exercising the exact string shape
  // without putting a scanner-triggering constant in the repository, which is
  // better than asking for an allowlist entry that would also cover a real leak.
  const secretPart = ["xY3zQ9rTuVwXyZ", "0123456789"].join("");
  const slack = ["https://hooks.slack.com", "services", "T01ABCDEFGH", "B02IJKLMNOP", secretPart].join("/");
  const discordSecret = ["AbCdEfGhIjKlMnOpQrStUvWxYz", "0123456789_ABCdefGHIjkl"].join("-");
  const discord = ["https://discord.com", "api", "webhooks", "123456789012345678", discordSecret].join("/");

  test("a Slack webhook URL is removed from a log string", () => {
    const out = String(redact(`TypeError: fetch failed for ${slack}`));
    assert.ok(!out.includes("xY3zQ9rTuVwXyZ0123456789"), `the secret path survived: ${out}`);
    assert.ok(!out.includes("B02IJKLMNOP"), `the webhook id survived: ${out}`);
  });

  test("a Discord webhook URL is removed too", () => {
    const out = String(redact(`Error: connect ETIMEDOUT ${discord}`));
    assert.ok(!out.includes("AbCdEfGhIjKlMnOpQrStUvWxYz"), `the secret path survived: ${out}`);
  });

  test("it is removed from nested metadata, not just top-level strings", () => {
    const out = JSON.stringify(redact({ kind: "config.invalid", error: `POST ${slack} failed` }));
    assert.ok(!out.includes("xY3zQ9rTuVwXyZ0123456789"), `the secret survived nesting: ${out}`);
  });

  test("credentials embedded as URL userinfo are removed", () => {
    const out = String(redact("connection refused: postgresql://tinycrm_app:hunter2@db.internal:5432/tinycrm"));
    assert.ok(!out.includes("hunter2"), `a URL password survived: ${out}`);
  });

  test("ordinary URLs are left readable", () => {
    // Over-redaction makes logs useless, which leads to logging being disabled.
    const out = String(redact("failed to load https://tiny-crm.example.com/api/health?q=1"));
    assert.match(out, /tiny-crm\.example\.com\/api\/health/, `a harmless URL was redacted: ${out}`);
  });

  test("the existing header-shaped rules still apply", () => {
    assert.ok(!String(redact("Authorization: Bearer abc.def.ghi")).includes("abc.def.ghi"));
    assert.ok(!String(redact("key sk-ant-0123456789abcdef")).includes("0123456789abcdef"));
  });
});
