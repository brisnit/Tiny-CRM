import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * The committed datasource provider must be sqlite.
 *
 * `npm run test:pg` rewrites prisma/schema.prisma to postgresql for the length
 * of a run and restores it on the way out. An interrupted run — or a `git add
 * -A` in the window before it restores — commits the flip. That has now
 * happened twice. Both times CI caught it, and both times it cost a red build
 * across five jobs whose failure gave no hint of the cause.
 *
 * Deployment is unaffected either way: the Vercel build runs
 * `use-provider.mjs auto`, which resolves the provider from DATABASE_URL. What
 * breaks is every developer and every CI job that starts from a clean checkout
 * and expects SQLite, which is most of them.
 *
 * This asserts on the *committed* blob rather than the working tree, precisely
 * so it stays true while `npm run test:pg` is mid-run and has the file
 * legitimately flipped.
 */
describe("the committed schema is the one a fresh clone needs", () => {
  test("prisma/schema.prisma is committed with provider = sqlite", () => {
    const root = resolve(import.meta.dirname, "../..");
    let committed: string;
    try {
      committed = execFileSync("git", ["show", "HEAD:prisma/schema.prisma"], {
        cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return; // no git (a tarball, a vendored copy) — nothing to assert against
    }
    const provider = /datasource\s+db\s*\{[^}]*provider\s*=\s*"([^"]+)"/.exec(committed)?.[1];
    assert.equal(
      provider,
      "sqlite",
      `the committed datasource provider is "${provider}". A test:pg run leaves it on ` +
        `postgresql; restore it with "node scripts/use-provider.mjs sqlite" before committing.`,
    );
  });
});
