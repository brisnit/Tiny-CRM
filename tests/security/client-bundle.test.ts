import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * What ends up in the browser.
 *
 * A `"use client"` module is shipped to every visitor, signed in or not. Any
 * literal in one is public. This suite reads the source of every client
 * component and asserts that nothing which must stay on the server appears in
 * one — a check no feature test performs, and the exact mistake that put demo
 * credentials into the production bundle (F-21).
 */

const ROOT = resolve(import.meta.dirname, "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "generated" || entry.startsWith(".")) continue;
      walk(path, out);
    } else if (/\.(tsx?|jsx?)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

const sources = walk(join(ROOT, "src")).map((path) => ({
  path: path.slice(ROOT.length + 1),
  text: readFileSync(path, "utf8"),
}));

const clientModules = sources.filter((f) => /^\s*["']use client["']/.test(f.text));

describe("client bundle", () => {
  test("there are client components to check", () => {
    // Guards against the walk silently finding nothing and every test below
    // passing vacuously.
    assert.ok(clientModules.length > 10, `only found ${clientModules.length} client modules`);
  });

  test("no client component contains a credential literal", () => {
    // The seeded demo password and account, which used to be hardcoded in the
    // login form and were therefore in every production bundle.
    const forbidden = [/["']tinycrm["']/, /brisnit@/i, /demo@tinycrm/i];

    for (const file of clientModules) {
      for (const pattern of forbidden) {
        assert.ok(
          !pattern.test(file.text),
          `${file.path} ships a credential literal to the browser (${pattern})`,
        );
      }
    }
  });

  test("no client component reads a server secret", () => {
    const forbidden = [
      "AUTH_SECRET", "DATABASE_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
      "BILLING_WEBHOOK_SECRET", "RATE_LIMIT_REDIS_URL", "TINYCRM_TEST_IDENTITY",
    ];

    for (const file of clientModules) {
      for (const name of forbidden) {
        // Only an actual read counts. Naming a variable in help text — "add an
        // ANTHROPIC_API_KEY for open-ended answers" — is exactly what an
        // operator needs to see and reveals nothing.
        assert.ok(
          !new RegExp(`process\\.env\\.${name}\\b`).test(file.text),
          `${file.path} reads ${name} in the browser, where it is either absent or public`,
        );
      }
    }
  });

  test("no client component imports a server-only module", () => {
    // These modules read the database or the environment. Importing one from a
    // client component either fails the build or, worse, pulls its constants in.
    const forbidden = [
      "@/lib/db", "@/lib/auth/access", "@/lib/auth/context", "@/lib/audit",
      "@/lib/entitlements", "@/lib/events", "@/lib/billing", "@/lib/uploads",
      "@/auth",
    ];

    for (const file of clientModules) {
      for (const name of forbidden) {
        assert.ok(
          !new RegExp(`from ["']${name.replace(/[/*+?()[\]{}]/g, "\\$&")}["']`).test(file.text),
          `${file.path} imports ${name}, which is server-only`,
        );
      }
    }
  });

  test("no NEXT_PUBLIC_ variable gates a security decision", () => {
    // A NEXT_PUBLIC_ value is visible to and editable by the client, so it can
    // never be an authorization or feature-security control.
    const securityish = /NEXT_PUBLIC_[A-Z_]*(ADMIN|AUTH|SECRET|ALLOW|BYPASS|DEMO|ROLE|PERMISSION)/;
    for (const file of sources) {
      const match = securityish.exec(file.text);
      assert.equal(
        match,
        null,
        `${file.path} gates something on ${match?.[0]}, which the client controls`,
      );
    }
  });

  test("the password rule shown to users matches the one enforced", async () => {
    const { PASSWORD_MIN_LENGTH } = await import("../../src/lib/auth/password");
    // A form that accepts 8 characters against a server that requires 12 does
    // not weaken anything, but it does reject valid-looking input with an
    // unexplained error.
    const form = clientModules.find((m) => m.path.endsWith("auth-forms.tsx"));
    assert.ok(form, "the sign-up form was not found");
    assert.ok(
      !/minLength=\{\d+\}/.test(form!.text),
      "the sign-up form hardcodes a minimum length instead of using PASSWORD_MIN_LENGTH",
    );
    assert.ok(PASSWORD_MIN_LENGTH >= 12);
  });
});
