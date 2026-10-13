import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const SETTINGS = "src/app/(app)/settings/integrations/page.tsx";

/**
 * The privacy promises the product makes out loud, checked against the code
 * that would have to keep them.
 *
 * This exists because one of them was false and shipped. Settings told every
 * customer that imported mail "become[s] visible to the workspace only when
 * you attach one to a contact, company, deal or project yourself". Attaching
 * writes `contactId` and never touches `visibility` — and the importer
 * attaches automatically whenever it finds one unambiguous contact — so the
 * sentence described a control that did not exist, attached to a mechanism
 * that does not do what it said.
 *
 * The error was conservative: items stayed more private than promised. The
 * next one might not be. A claim about who can see somebody's correspondence
 * is worth a test even when the claim is only prose.
 */

async function sourceFiles(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated") continue;
      await sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

describe("what Settings says about imported mail is what the code does", () => {
  test("nothing in the application shares an imported item", async () => {
    /**
     * The tripwire. If sharing is ever built, this fails — and whoever builds
     * it has to come here, which puts them one line away from the sentence in
     * Settings that will then need changing back.
     */
    const offenders: string[] = [];
    for (const file of await sourceFiles(join(ROOT, "src"))) {
      const rel = relative(ROOT, file);
      // The importer names these fields in a comment explaining that it must
      // never write them, and the visibility helper names the value it reads.
      if (
        rel === "src/lib/integrations/sync/import-events.ts" ||
        rel === "src/lib/integrations/visibility.ts"
      ) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      for (const pattern of [
        /visibility:\s*["']workspace["']/,
        /sharedAt:\s*(?!null)/,
        /sharedById:\s*(?!null)/,
      ]) {
        if (pattern.test(source)) offenders.push(`${rel}  ${pattern}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "Something now shares an imported item. That is a feature, not a bug — but the " +
        "Settings copy says there is no way to do it, and the privacy notice draft says " +
        "the same. Update both:\n" +
        offenders.join("\n"),
    );
  });

  test("Settings does not claim that attaching an item shares it", () => {
    const copy = readFileSync(join(ROOT, SETTINGS), "utf8");
    assert.doesNotMatch(
      copy,
      /become visible to the workspace only when you attach/,
      "the retracted claim is back: attaching writes contactId and never touches visibility",
    );
    assert.match(
      copy,
      /no way to share one with your workspace/,
      "Settings no longer says that imported items cannot be shared",
    );
    assert.match(
      copy,
      /attaching an item to a\s+contact does not change who can see it/,
      "Settings no longer corrects the attachment misconception",
    );
  });

  test("the read-only claim matches the scopes actually requested", async () => {
    const { PROVIDERS } = await import("../../src/lib/integrations/providers");
    const copy = readFileSync(join(ROOT, SETTINGS), "utf8");
    assert.match(copy, /Read-only/i, "Settings no longer says the access is read-only");

    for (const provider of Object.values(PROVIDERS)) {
      for (const scope of provider.scopes) {
        assert.doesNotMatch(
          scope,
          /\.(Send|ReadWrite|Write|Modify)\b/i,
          `${provider.id} requests ${scope}, which is not read-only — Settings and the ` +
            `privacy draft both say the access cannot change anything`,
        );
      }
    }
  });

  test("the AI-exclusion claim matches the predicate that enforces it", async () => {
    const copy = readFileSync(join(ROOT, SETTINGS), "utf8");
    assert.match(copy, /not sent to Tiny AI/i, "Settings no longer makes the AI exclusion claim");

    const predicate = readFileSync(join(ROOT, "src/lib/ai/imported-data.ts"), "utf8");
    assert.match(
      predicate,
      /source/,
      "the exclusion no longer keys on the immutable provenance column",
    );
    // Both call sites that once pulled subjects into a prompt must still spread it.
    for (const file of ["src/lib/ai/context.ts", "src/lib/ai/recommendations.ts"]) {
      assert.match(
        readFileSync(join(ROOT, file), "utf8"),
        /EXCLUDE_IMPORTED/,
        `${file} no longer excludes imported correspondence from what reaches a model provider`,
      );
    }
  });
});
