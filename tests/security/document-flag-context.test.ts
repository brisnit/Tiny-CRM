import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The shape that stops the flag defect happening a fourth time.
 *
 * `FeatureFlag` is workspace-scoped and under row-level security:
 *
 *   USING ("workspaceId" IS NULL OR app_can_see_workspace("workspaceId"))
 *
 * A workspace override is visible only while `app.workspace_ids` is set. Read
 * outside a tenant context the row is filtered, `isEnabled` falls back to the
 * built-in default, and the flag is silently ignored. That has now happened
 * three times here — the document download route, the Project page (which
 * reached production), and the AI chat route.
 *
 * `documentAi` defaults to **false**, which changes the shape of the failure
 * but not its severity. A missed context makes it read `false` and Document
 * Intelligence silently stops working for a workspace that paid for it —
 * failing closed rather than open, and just as silent.
 *
 * Two guards, because they catch different mistakes:
 *
 *  1. Every `documentAi` read goes through the gate module, which asserts a
 *     tenant context at runtime on both engines.
 *  2. Nothing outside that module names the flag directly.
 *
 * Deliberately not engine-gated. The source is identical on both engines, and
 * this has to hold on the one whose lack of row-level security hides the
 * mistake in the first place.
 */

const GATE = "src/lib/documents/gate.ts";

/** Every .ts file under src/, so a new caller cannot be added unnoticed. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) found.push(full);
    }
  };
  walk(resolve(process.cwd(), "src"));
  return found;
}

const relative = (path: string) => path.replace(process.cwd() + "/", "");

describe("documentAi is only ever read through the gate", () => {
  test("no source file outside the gate names the flag", () => {
    // src/lib/flags.ts declares it; the gate reads it. Anywhere else is a
    // direct read that would bypass the tenant-context assertion.
    const allowed = new Set([GATE, "src/lib/flags.ts"]);

    const offenders = sourceFiles()
      .filter((file) => !allowed.has(relative(file)))
      // A quoted string literal, which is what a flag read looks like:
      //   isEnabled("documentAi") / requireFlag('documentAi')
      // Prose in a comment writes it in backticks and is not a read.
      .filter((file) => /["']documentAi["']/.test(readFileSync(file, "utf8")))
      .map(relative);

    assert.deepEqual(
      offenders,
      [],
      "these files name the documentAi flag directly. Read it through " +
        "requireDocumentIntelligence()/documentIntelligenceEnabled() in " +
        `${GATE}, which asserts a tenant context first — a workspace-scoped ` +
        "flag read without one is filtered by RLS and silently falls back to " +
        "the built-in default.",
    );
  });

  test("the gate asserts a tenant context before every flag read", () => {
    const source = readFileSync(resolve(process.cwd(), GATE), "utf8");

    // Both entry points must assert before reading.
    for (const fn of ["requireDocumentIntelligence", "documentIntelligenceEnabled"]) {
      const body = source.slice(source.indexOf(`export async function ${fn}`));
      const end = body.indexOf("\n}");
      const scoped = body.slice(0, end);

      assert.ok(scoped.length > 0, `${fn} not found in ${GATE}`);
      assert.match(
        scoped,
        /assertTenantContext\(/,
        `${fn} reads a workspace-scoped flag without asserting a tenant context first`,
      );

      const assertAt = scoped.indexOf("assertTenantContext(");
      const readAt = Math.min(
        ...[scoped.indexOf("requireFlag("), scoped.indexOf("isEnabled(")].filter((i) => i >= 0),
      );
      assert.ok(
        assertAt < readAt,
        `${fn} reads the flag before asserting the tenant context`,
      );
    }
  });

  test("the gate does not open a tenant context of its own", () => {
    // A gate that establishes its own authority is not a gate. The caller has
    // to have earned the workspace it is asking about, from its own
    // memberships — never from a request.
    const source = readFileSync(resolve(process.cwd(), GATE), "utf8");
    assert.ok(
      !/withTenantContext\s*\(/.test(source),
      `${GATE} opens a tenant context. It must assert one, not create one: ` +
        "otherwise the check grants itself the scope it is supposed to verify.",
    );
  });

  test("all three gates are required, and named in one place", () => {
    const source = readFileSync(resolve(process.cwd(), GATE), "utf8");
    const match = /DOCUMENT_INTELLIGENCE_FLAGS = \[([^\]]+)\]/.exec(source);
    assert.ok(match, "the flag list is no longer a single declared constant");

    const flags = [...match[1]!.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(
      flags.sort(),
      ["ai", "documentAi", "files"],
      "Document Intelligence must require files AND ai AND documentAi",
    );
  });

  test("documentAi ships disabled", () => {
    const flags = readFileSync(resolve(process.cwd(), "src/lib/flags.ts"), "utf8");
    const block = flags.slice(flags.indexOf("documentAi:"));
    const defaultValue = /default:\s*(true|false)/.exec(block)?.[1];
    assert.equal(
      defaultValue,
      "false",
      "documentAi must default to false so this phase deploys dark",
    );
  });
});

describe("the ingestion event keeps its handler", () => {
  test("no automation trigger is mapped to file.uploaded", () => {
    /**
     * `registerHandler` stores handlers in a Map, so the last registration for
     * a name wins. `registerJobHandlers` registers the generic automation
     * handler for every domain event, then registers the ingestion handler for
     * `file.uploaded` — replacing it.
     *
     * That is safe only while no automation trigger maps to `file.uploaded`,
     * because the generic handler's first act is to return when there is none.
     * If somebody adds one, it would silently never fire. This is the test that
     * makes that a failure instead of a mystery.
     */
    const events = readFileSync(resolve(process.cwd(), "src/lib/events.ts"), "utf8");
    const table = events.slice(events.indexOf("TRIGGER_FOR_EVENT"));
    const mapped = table.slice(0, table.indexOf("};"));

    assert.ok(
      !/"file\.uploaded"\s*:/.test(mapped),
      "an automation trigger was mapped to file.uploaded, but the ingestion handler " +
        "replaces the generic automation handler for that event — the trigger would " +
        "never fire. Compose the two handlers instead.",
    );
  });
});
