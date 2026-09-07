import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { scrubMessage, scrubStack } from "../../src/lib/observability";
import { SECRETS, realisticStack, plainStack } from "../helpers/leak-fixtures";

/**
 * What actually leaves the process in an error report.
 *
 * `scrubMessage` was correct and `exception.value` was clean — but a Node stack
 * *begins with the error message*, and `scrubStack` only rewrote file paths. The
 * adapter sends the stack as `logentry.formatted`, so the full unscrubbed
 * message travelled anyway, one field further down the same payload.
 *
 * Found by intercepting the outbound request and reading the bytes rather than
 * by reading the scrubbing code, which looked right in isolation. The captured
 * payload contained a database password, the Slack webhook, the Resend key, a
 * session token, an email address and the text of a CRM note.
 */


describe("nothing sensitive survives into an error report", () => {
  test("the stack is scrubbed, not only the message", () => {
    const out = scrubStack(realisticStack) ?? "";
    for (const [label, secret] of Object.entries(SECRETS)) {
      assert.ok(!out.includes(secret), `${label} survived in the stack:\n${out}`);
    }
  });

  test("the message itself is scrubbed", () => {
    const out = scrubMessage(realisticStack.split("\n")[0]!);
    assert.ok(!out.includes(SECRETS.note), `CRM note text survived: ${out}`);
    assert.ok(!out.includes(SECRETS.email), `an email address survived: ${out}`);
  });

  test("a database URL password never survives", () => {
    const out = scrubMessage(`connect failed postgresql://tinycrm_app:${SECRETS.dbPassword}@db.internal/tinycrm`);
    assert.ok(!out.includes(SECRETS.dbPassword), `a database password survived: ${out}`);
  });

  test("a webhook URL never survives", () => {
    const out = scrubMessage(`POST https://hooks.slack.com/services/T0/B0/${SECRETS.webhookSecret} failed`);
    assert.ok(!out.includes(SECRETS.webhookSecret), `a webhook secret survived: ${out}`);
  });

  test("the stack still names the code that failed", () => {
    // Over-scrubbing produces reports nobody can act on, which is its own
    // failure: the point is a diagnosable error, not an empty one.
    const out = scrubStack(realisticStack) ?? "";
    assert.match(out, /contacts\.ts/, `the failing file was scrubbed away:\n${out}`);
    assert.match(out, /at handler/, `the frame was scrubbed away:\n${out}`);
  });

  test("absolute filesystem paths are still removed", () => {
    const out = scrubStack("Error: x\n    at f (/Users/someone/app/src/lib/db.ts:1:1)") ?? "";
    assert.ok(!out.includes("/Users/someone"), `a filesystem path survived: ${out}`);
  });

  test("the same secrets are removed from an error that is not a Prisma error", () => {
    // The Prisma fixture above passed while a session token and an API key were
    // leaving the process: its one rule spans to the first stack frame and
    // removed the whole block, so nothing else was ever tested. This is the
    // same content behind a plain TypeError, where every rule stands alone.
    const out = scrubStack(plainStack) ?? "";
    for (const [label, secret] of Object.entries(SECRETS)) {
      assert.ok(!out.includes(secret), `${label} survived a non-Prisma stack:\n${out}`);
    }
    assert.match(out, /contacts\.ts/, `the failing file was scrubbed away:\n${out}`);
  });
});
