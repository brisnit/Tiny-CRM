import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Who is allowed to say "no restriction applies here".
 *
 * The type system asks every context that names a person to declare its scope,
 * and that is checkable. What it cannot check is whether the declaration is
 * *true*: `NO_RECORD_READS` claims the context reads no CRM record, and only a
 * person can know that. So the claim is pinned instead.
 *
 * A production file that declares an unrestricted scope — through the constant
 * or a bare `[]` — and is not listed below fails this test. Adding it means
 * writing down why, which is the point: the next person to widen this boundary
 * has to say so out loud, in a diff someone reviews.
 *
 * This is a tripwire, not a proof. If `audit.ts` grew a CRM lookup tomorrow its
 * entry would still be here and this test would still pass. What it catches is
 * the commoner failure: a new context quietly copying the shape of an old one.
 */

const ALLOWED: Record<string, string> = {
  // --- Machinery that writes about records without reading any -------------
  "src/lib/audit.ts":
    "AuditLog is outside record scope; the context exists for the workspace policy alone",
  "src/lib/events.ts": "DomainEvent is outside record scope",
  "src/lib/jobs.ts": "job bookkeeping — claims and run rows, never CRM records",
  "src/lib/jobs/handlers.ts": "notification delivery; Notification is person-scoped",
  "src/lib/automations.ts":
    "D6: automations run workspace-wide and what reaches a person is filtered at delivery",
  "src/lib/security/alerts.ts": "security alerts must be written whoever triggered them",

  // --- Identity and membership, which precede any record -------------------
  "src/lib/auth/context.ts":
    "getMemberships is the lookup that derives memberships; it cannot consult them",
  "src/lib/auth/invitations.ts": "invitation tables are not records and predate membership",
  "src/lib/workspaces/provision.ts":
    "bootstrap: no grants exist, and the membership that would carry a scope is being created",

  // --- Person-scoped AI storage --------------------------------------------
  "src/lib/ai/crm-agent.ts": "AiThread and AiMessage are person-scoped by S7, not record-scoped",

  // --- The one exception that genuinely reads records ----------------------
  "src/lib/entitlements.ts":
    "plan usage is a property of the workspace, not a view of it: counting only what a " +
    "restricted member can see would under-report and stop enforcing the limit",

  // --- The definition itself ------------------------------------------------
  "src/lib/tenant-db.ts": "defines NO_RECORD_READS",
};

/** Every .ts/.tsx file under src, except the generated client. */
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

describe("declaring an unrestricted scope is an allowlisted act", () => {
  test("no production file claims one without a written reason", async () => {
    const files = await sourceFiles("src");
    const claiming: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const claims =
        source.includes("NO_RECORD_READS") ||
        /restrictedWorkspaceIds:\s*\[\s*\]/.test(source);
      if (claims) claiming.push(relative(process.cwd(), file));
    }

    const unlisted = claiming.filter((f) => !(f in ALLOWED));
    assert.deepEqual(
      unlisted,
      [],
      `these files declare an unrestricted scope and are not on the allowlist:\n` +
        unlisted.map((f) => `  ${f}`).join("\n") +
        `\n\nIf that is right, add each to ALLOWED in this file with the reason it reads no ` +
        `records. If it is not right, derive the scope from the actor with restrictedIdsFor.`,
    );
  });

  test("the allowlist has no stale entries", async () => {
    // A list nobody prunes stops being a list of decisions and becomes
    // background noise, which is how the next exception slips in unnoticed.
    const files = await sourceFiles("src");
    const claiming = new Set(
      files
        .filter((file) => {
          const source = readFileSync(file, "utf8");
          return (
            source.includes("NO_RECORD_READS") ||
            /restrictedWorkspaceIds:\s*\[\s*\]/.test(source)
          );
        })
        .map((file) => relative(process.cwd(), file)),
    );

    const stale = Object.keys(ALLOWED).filter((f) => !claiming.has(f));
    assert.deepEqual(stale, [], `allowlisted files that no longer declare one: ${stale.join(", ")}`);
  });

  test("ordinary actor paths still derive their scope", async () => {
    // The allowlist is only meaningful while the paths that matter are not on
    // it. These four are where a restricted member's reads and writes are
    // decided, and each must ask the actor's memberships rather than assert an
    // answer.
    for (const file of [
      "src/lib/actions/base.ts",
      "src/lib/auth/access.ts",
      "src/lib/ai/classification.ts",
      "src/app/api/ai/chat/route.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      assert.ok(
        source.includes("restrictedIdsFor"),
        `${file} should derive its scope from the actor, not declare one`,
      );
      assert.ok(!(file in ALLOWED), `${file} must never be allowlisted`);
    }
  });
});
