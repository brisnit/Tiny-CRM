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

describe("correspondence cannot ride out in an error report", () => {
  /**
   * Written when a privacy notice was about to promise that error reports
   * carry no message contents. Scrubbing tokens and passwords does not
   * establish that: a subject line is not a token, contains no URL and no
   * address, and every content rule passed it through untouched.
   *
   * Probing the scrubber with the shapes a database and a parser actually
   * produce found two that leaked. Both are fixed below. The two that still
   * leak are recorded here as well, because a test that only shows the wins
   * would be the same mistake in a different place.
   */
  const SUBJECT = "Q4 pricing for Acme";
  const SNIPPET = "As discussed on the call,";
  const TITLE = "Board review — Acme renewal";

  test("PostgreSQL's failing-row detail does not carry the row", () => {
    // A check constraint or a not-null on a column Prisma does not model
    // surfaces the driver's text unchanged, and the driver quotes the row.
    const message =
      `new row for relation "EmailMessage" violates check constraint "c"\n` +
      `DETAIL:  Failing row contains (cuid1, wsp1, outlook, ext-1, t-1, ` +
      `${SUBJECT}, ${SNIPPET}, someone@client.test).`;
    const out = scrubMessage(message);
    assert.doesNotMatch(out, /Q4 pricing/, "a subject survived a constraint violation");
    assert.doesNotMatch(out, /As discussed/, "a snippet survived a constraint violation");
    assert.match(out, /violates check constraint/, "the fault itself was scrubbed away too");
  });

  test("a JSON parse failure does not carry the document", () => {
    // Job payloads and provider responses both reach JSON.parse, and a
    // provider response holds subjects and snippets.
    const out = scrubMessage(
      `Unexpected token A in JSON at position 42: {"subject":"${SUBJECT}","bodyPreview":"${SNIPPET}"}`,
    );
    assert.doesNotMatch(out, /Q4 pricing/, "a subject survived a JSON parse failure");
    assert.doesNotMatch(out, /As discussed/, "a snippet survived a JSON parse failure");
    assert.match(out, /Unexpected token/, "the fault itself was scrubbed away too");
  });

  test("a Prisma invocation echo does not carry the row", () => {
    const out = scrubMessage(
      "Invalid `prisma.emailMessage.create()` invocation in /app/src/x.ts:12\n\n" +
        `  subject: '${SUBJECT}', snippet: '${SNIPPET}'\n    at async f (/app/src/x.ts:1:1)`,
    );
    assert.doesNotMatch(out, /Q4 pricing/);
    assert.doesNotMatch(out, /As discussed/);
  });

  test("an address is removed wherever it appears", () => {
    assert.doesNotMatch(scrubMessage("refused delivery to someone@client.test"), /someone@/);
  });

  test("a report stays useful: ordinary messages and stack frames survive", () => {
    /**
     * The other half of the job, and the one a scrubbing rule breaks first.
     * This file already records an incident where an unbounded pattern
     * erased every frame — "an error report with no frames is not a safer
     * report, it is a useless one" — and the JSON rule added here repeated
     * it exactly: applied to a stack whose top line is a SyntaxError it
     * removed all three frames, so the report said a parse failed and
     * nothing about where. Caught by probing a STACK rather than a message.
     */
    const plain = "Cannot read properties of undefined (reading 'id')";
    assert.equal(scrubMessage(plain), plain, "an ordinary message was altered");

    const ordinary = scrubStack(
      [
        "TypeError: Cannot read properties of undefined (reading 'id')",
        "    at resolveActor (/app/src/lib/auth/access.ts:51:26)",
        "    at requirePlatformAdmin (/app/src/lib/admin/authorize.ts:137:23)",
        "    at async POST (/app/src/app/api/x/route.ts:12:3)",
      ].join("\n"),
    );
    assert.equal((ordinary?.match(/\n\s+at /g) ?? []).length, 3, "ordinary frames were lost");
    assert.match(ordinary ?? "", /access\.ts/, "the stack no longer names the code that failed");

    // The regression: a redactable shape on the FIRST line of a stack.
    const jsonStack = scrubStack(
      [
        "SyntaxError: Unexpected token A in JSON at position 42",
        "    at JSON.parse (<anonymous>)",
        "    at runJobs (/app/src/lib/jobs.ts:210:20)",
        "    at async drain (/app/scripts/worker.ts:50:18)",
      ].join("\n"),
    );
    assert.equal(
      (jsonStack?.match(/\n\s+at /g) ?? []).length,
      3,
      "the JSON rule ate the stack frames — bound it at the first frame",
    );
    assert.match(jsonStack ?? "", /jobs\.ts/, "the stack no longer names the code that failed");

    const rowStack = scrubStack(
      [
        'error: new row for relation "EmailMessage" violates check constraint "c"',
        "DETAIL:  Failing row contains (a, b, Q4 pricing for Acme, c).",
        "    at Parser.parseErrorMessage (/app/node_modules/pg/x.js:1:1)",
        "    at importPage (/app/src/lib/x.ts:94:5)",
      ].join("\n"),
    );
    assert.equal((rowStack?.match(/\n\s+at /g) ?? []).length, 2, "the row rule ate the frames");
    assert.doesNotMatch(rowStack ?? "", /Q4 pricing/, "the row survived in the stack");

    // And the fault is still identifiable in each message.
    assert.match(
      scrubMessage('new row for relation "EmailMessage" violates check constraint "c"\n' +
        "DETAIL:  Failing row contains (a, Q4 pricing for Acme)."),
      /violates check constraint/,
    );
    const parsed = scrubMessage('Unexpected token A in JSON at position 42: {"subject":"Q4"}');
    assert.match(parsed, /Unexpected token/);
    assert.match(parsed, /position 42/, "the offset was mangled — anchor the lookbehind on the colon");
  });

  test("prose written into an error message is NOT removed, and cannot be", () => {
    /**
     * The honest boundary, asserted rather than left to be discovered.
     *
     * No regular expression recognises ordinary English: "Q4 pricing for
     * Acme" has no token, no address and no structure to anchor on. The same
     * argument the tag rule makes — that deciding whether a string is
     * customer data is not something a pattern can do — applies here, and
     * there is no identifier shape to fall back on because an error message
     * is prose by nature.
     *
     * So this is a CODE REVIEW property, not a scrubbing one: no code path
     * may interpolate correspondence into an exception message. The guard
     * for that is the test below, not this one. This test exists so that
     * nobody reads the four above and concludes the scrubber makes it
     * impossible.
     */
    assert.match(
      scrubMessage(`could not import message: ${SUBJECT}`),
      /Q4 pricing/,
      "if this now passes, the scrubber has learned to recognise prose — rewrite the claim",
    );
    assert.match(scrubMessage(`calendar import failed for event: ${TITLE}`), /Board review/);
  });
});

describe("no code path puts correspondence into an exception message", () => {
  test("nothing interpolates a subject, snippet, body or title into an Error", async () => {
    const { readFileSync } = await import("node:fs");
    const { readdir } = await import("node:fs/promises");
    const { join, relative } = await import("node:path");
    const root = join(import.meta.dirname, "../..");

    async function walk(dir: string, acc: string[] = []): Promise<string[]> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "generated") continue;
          await walk(full, acc);
        } else if (/\.tsx?$/.test(entry.name)) acc.push(full);
      }
      return acc;
    }

    /**
     * The fields that hold correspondence. An exception MESSAGE built from
     * any of them reaches the reporter as prose, which nothing downstream can
     * recognise.
     *
     * `internal:` lines are excluded deliberately, and the exclusion is load
     * bearing rather than convenient: `AppError.internal` is a separate
     * property, and `buildPayload` reads only `raw.message` and `raw.stack`,
     * so nothing passed as `internal` is ever sent to an error reporter. It
     * reaches the structured log and stops there. The first version of this
     * test did not make the distinction and flagged two call sites that are
     * correct — one of which deliberately reports `body.length` rather than
     * `body` for exactly this reason.
     *
     * `body` is not in the list either: it is too generic a word, and it was
     * what produced both false positives.
     */
    const CONTENT = /\b(?:subject|snippet|bodyPreview|title|description|fromEmail|accountEmail|toJson)\b/;
    const THROWS = /(?:throw new [A-Za-z]*Error|new Error)\(/;

    const offenders: string[] = [];
    for (const file of await walk(join(root, "src"))) {
      const rel = relative(root, file);
      for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
        // Never sent to a reporter — see the note above.
        if (/\binternal:/.test(line)) continue;
        if (!THROWS.test(line)) continue;
        const interpolations = line.match(/\$\{[^}]*\}/g) ?? [];
        if (interpolations.some((value) => CONTENT.test(value))) {
          offenders.push(`${rel}:${index + 1}  ${line.trim().slice(0, 90)}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "These build an exception message out of correspondence. It will reach the error " +
        "reporter as prose and no scrubbing rule can recognise it:\n" + offenders.join("\n"),
    );
  });
});
