import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/**
 * A password must never be able to reach a URL.
 *
 * Every form in auth-forms.tsx submits through `onSubmit`, which calls
 * `preventDefault()`. That is the only thing that was keeping credentials out
 * of the query string, and it does not apply before React hydrates or when the
 * script fails to load. A form with no `method` defaults to GET, so in those
 * windows the browser put every field in the URL. Reproduced against the
 * deployed application with JavaScript disabled, on all five forms:
 *
 *   /login  ?email=…&password=…      /signup  ?name=…&email=…&password=…
 *   /reset-password ?password=…&confirm=…   (and the ?token= was replaced)
 *
 * A URL is not a transient thing. It is written to browser history in
 * plaintext, offered back in address-bar autocomplete, and synced across
 * devices when browser sync is on.
 *
 * These are source assertions on purpose. The property is about what the
 * *browser* does with markup when no JavaScript is running, which a server test
 * cannot exercise — and the behaviour was confirmed in a real browser with
 * scripting disabled before this file was written. What these catch is the
 * regression: a sixth form added later, or the attribute removed by someone
 * who reads it as noise because `preventDefault()` makes it look unused.
 */

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(resolve(ROOT, dir))) {
    const rel = join(dir, entry);
    if (statSync(resolve(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (/\.tsx$/.test(entry)) out.push(rel);
  }
  return out;
}

/** `<form …>` openings, with their attributes, from one file. */
function forms(source: string): string[] {
  return [...source.matchAll(/<form\b[^>]*>/g)].map((m) => m[0]);
}

describe("credentials cannot be transmitted in a URL", () => {
  test("every form in auth-forms.tsx posts", () => {
    const found = forms(read("src/components/app/auth-forms.tsx"));
    assert.ok(found.length >= 5, `expected the five auth forms, found ${found.length}`);
    for (const form of found) {
      assert.match(
        form,
        /method="post"/,
        `an auth form defaults to GET, which puts its fields in the query string: ${form}`,
      );
    }
  });

  test("no form anywhere holds a password field without posting", () => {
    // The general rule, so a credential form added elsewhere is covered too.
    for (const file of walk("src/components")) {
      const source = read(file);
      if (!/type="password"/.test(source)) continue;
      for (const form of forms(source)) {
        assert.match(
          form,
          /method="post"/,
          `${file} has a password field and a form that defaults to GET: ${form}`,
        );
      }
    }
  });

  test("the reset token travels in the URL, so the form must not resubmit it there", () => {
    // /reset-password?token=… is a bearer credential in a URL by necessity —
    // that is how an emailed link works. What must not happen is the *new*
    // password joining it. A GET submit did exactly that, and replaced the
    // token in the process, so the flow broke and leaked at the same time.
    const source = read("src/components/app/auth-forms.tsx");
    const reset = source.slice(source.indexOf("export function ResetPasswordForm"));
    const form = forms(reset)[0] ?? "";
    assert.match(form, /method="post"/, "the reset-password form defaults to GET");
  });

  test("the observability payload cannot carry a query string", () => {
    // Belt and braces with tests/unit/observability-payload.test.ts: even if a
    // credential reaches a URL some other way, the error reporter must not
    // forward it to a third party.
    const observability = read("src/lib/observability.ts");
    assert.match(
      observability,
      /scrubRoute/,
      "the error payload no longer strips query strings from the route",
    );
  });
});
