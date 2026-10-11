import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Every `prisma/postgres/*.sql` file is applied everywhere it has to be.
 *
 * That list is written out by hand in five places — the CI workflow, the
 * PostgreSQL test runner, the backup round-trip, the hosted provisioner and
 * the deploy-gate proof — plus two operator runbooks. Adding a file and
 * missing one of them produces the worst available outcome: a policy that
 * exists in the repository, is applied locally, and is **absent from the
 * environment the tests run in**, so the suite proves the opposite of what it
 * claims.
 *
 * That is not hypothetical. `015_platform_admin_policies.sql` was added to the
 * four scripts and not to `.github/workflows/ci.yml`, which keeps its own
 * copy. Locally every RLS assertion passed; in CI the application role
 * happily inserted into a table whose policy had never been created, and six
 * tests that are supposed to prove an attacker cannot do something reported
 * that they could.
 *
 * So the list is checked rather than remembered.
 */

const ROOT = resolve(import.meta.dirname, "../..");

/** The SQL files that exist, in order. */
function sqlFiles(): string[] {
  return readdirSync(resolve(ROOT, "prisma/postgres"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Where the list is enumerated, and must stay complete. */
const CONSUMERS = [
  ".github/workflows/ci.yml",
  "scripts/run-tests-pg.mjs",
  "scripts/backup-test.mjs",
  "scripts/provision-hosted.mjs",
  "docs/DEPLOYMENT-CHECKLIST.md",
  "docs/STAGING-SETUP.md",
];

describe("the PostgreSQL SQL files are applied everywhere they are needed", () => {
  test("every file appears in every place that applies them", () => {
    const files = sqlFiles();
    assert.ok(files.length > 0, "no SQL files found — the glob is wrong");

    const missing: string[] = [];
    for (const consumer of CONSUMERS) {
      const source = readFileSync(resolve(ROOT, consumer), "utf8");
      for (const file of files) {
        if (!source.includes(file)) missing.push(`${consumer} is missing ${file}`);
      }
    }

    assert.deepEqual(
      missing,
      [],
      "A policy file is applied in some places and not others, which makes the\n" +
        "suite prove the opposite of what it claims wherever it is missing:\n" +
        missing.map((m) => `  ${m}`).join("\n"),
    );
  });

  test("the deploy-gate proof names every file too", () => {
    // It lists them without the extension, so it is checked separately rather
    // than being quietly excluded from the loop above.
    const source = readFileSync(resolve(ROOT, "scripts/deploy-gate-proof.mjs"), "utf8");
    const missing = sqlFiles()
      .map((f) => f.replace(/\.sql$/, ""))
      .filter((name) => !source.includes(name));
    assert.deepEqual(missing, [], `deploy-gate-proof.mjs does not name: ${missing.join(", ")}`);
  });
});
