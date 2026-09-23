import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { createTenant, cleanupTenants, db as observer, type Tenant } from "../helpers/fixtures";
import { POST as aiChat } from "../../src/app/api/ai/chat/route";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { resetRateLimit } from "../../src/lib/rate-limit";
import { withTenantContext } from "../../src/lib/tenant-db";
import { isPostgres } from "../../src/lib/env";

/**
 * Turning Tiny AI off for one workspace.
 *
 * `FeatureFlag` is workspace-scoped and under row-level security:
 *
 *   USING ("workspaceId" IS NULL OR app_can_see_workspace("workspaceId"))
 *
 * so a workspace override is visible only while `app.workspace_ids` is set.
 * Read outside a tenant context it is filtered out, `isEnabled` falls back to
 * the built-in default — and for `ai` that default is **true**. A workspace
 * that deliberately switched Tiny AI off therefore kept getting it.
 *
 * This is the third appearance of one mistake. The download route had it and
 * was fixed; the Project page had it and reached production, where the
 * Documents panel silently refused to render. This suite exists so the AI route
 * cannot be the fourth, and so the next workspace-scoped flag added here is
 * caught by a test rather than by a customer.
 *
 * PostgreSQL only: SQLite has no policies, so the override is readable from
 * anywhere and there is no boundary to observe. That is precisely why the
 * defect survived CI the first two times.
 */

const pgOnly = isPostgres ? undefined : { skip: "PostgreSQL with RLS only" };

let A: Tenant;

before(async () => {
  if (!isPostgres) return;
  A = await createTenant("AiFlag");

  // The workspace turns Tiny AI off. Nothing in the product can write this row
  // — there is no flag admin UI — so it stands for a deliberate operator or
  // support action, which is exactly the case that was being ignored.
  await observer.featureFlag.create({
    data: { key: "ai", enabled: false, workspaceId: A.workspaceId },
  });
});

after(async () => {
  if (!isPostgres) return;
  await cleanupTenants([A]);
});

describe("a workspace-scoped ai override", { concurrency: false }, () => {
  test("is invisible outside a tenant context, and visible inside one", pgOnly, async () => {
    // The mechanism, stated in both directions. Neither assertion changes with
    // the fix: the boundary is correct and stays correct. What changes is
    // whether the route reads the flag from inside the context it has earned.
    const { isEnabled } = await import("../../src/lib/flags");

    const outside = await isEnabled("ai", A.workspaceId);
    assert.equal(
      outside,
      true,
      "the override became readable with no tenant context — the RLS boundary has been weakened",
    );

    const inside = await withTenantContext(
      { workspaceIds: [A.workspaceId], userId: A.ownerId, restrictedWorkspaceIds: [] },
      () => isEnabled("ai", A.workspaceId),
    );
    assert.equal(inside, false, "the override was not respected even inside a tenant context");
  });

  test("the chat route refuses a focused question", pgOnly, async () => {
    await resetRateLimit("ai", { user: A.ownerId });
    await resetRateLimit("aiHourly", { user: A.ownerId });

    const response = await runAsTestIdentity(A.ownerId, () =>
      aiChat(
        new Request("http://localhost/api/ai/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            question: "What should I do about this project?",
            focus: { type: "project", id: A.projectId },
          }),
        }),
      ),
    );

    const body = await response.text();
    assert.equal(
      response.status,
      403,
      `Tiny AI answered for a workspace that had switched it off (status ${response.status}): ${body.slice(0, 200)}`,
    );
    assert.match(body, /not enabled for this workspace/);
  });

  test("the chat route refuses an unfocused question in that workspace", pgOnly, async () => {
    // The other branch: with exactly one readable workspace the route passes
    // that id, so it has the same defect and needs the same context.
    await resetRateLimit("ai", { user: A.ownerId });
    await resetRateLimit("aiHourly", { user: A.ownerId });

    const response = await runAsTestIdentity(A.ownerId, () =>
      aiChat(
        new Request("http://localhost/api/ai/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: "What needs my attention?" }),
        }),
      ),
    );

    const body = await response.text();
    assert.equal(
      response.status,
      403,
      `Tiny AI answered with no focus for a workspace that had switched it off: ${body.slice(0, 200)}`,
    );
  });
});

describe("the shape that keeps this fixed", { concurrency: false }, () => {
  test("every requireFlag in the AI chat route sits inside a tenant context", async () => {
    /**
     * A source assertion, because that is where this rule lives.
     *
     * The tests above prove the behaviour, but they prove it for `ai`. The next
     * workspace-scoped flag added to this route — `documentAi` is already
     * planned — would be a fresh instance of the same defect, silently
     * defaulting instead of failing, and no behavioural test would notice
     * because none would exist for it yet.
     *
     * So this counts. Every `requireFlag(` in the file must be reachable only
     * through a `withTenantContext(`; if the counts diverge, one was added bare.
     *
     * Deliberately not engine-gated: the source is identical on both engines,
     * and this has to hold on the one whose lack of row-level security hides
     * the mistake.
     */
    const { readFileSync } = await import("node:fs");
    const route = "src/app/api/ai/chat/route.ts";
    const source = readFileSync(route, "utf8");

    const calls = source.match(/requireFlag\(/g) ?? [];
    assert.ok(calls.length > 0, `${route} no longer calls requireFlag — update this test`);

    // Each match is a withTenantContext whose callback reaches a requireFlag.
    const guarded = source.match(/withTenantContext\([\s\S]{0,600}?requireFlag\(/g) ?? [];

    assert.equal(
      guarded.length,
      calls.length,
      `${route} calls requireFlag outside withTenantContext (${calls.length} call(s), ` +
        `${guarded.length} guarded). FeatureFlag is workspace-scoped and under RLS, so an ` +
        "override read without a tenant context is filtered and isEnabled falls back to the " +
        "built-in default — the flag is silently ignored.",
    );
  });
});
