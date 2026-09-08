import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

import { runAsTestIdentity } from "../../src/lib/auth/context";
import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

/**
 * AI is an enhancement. It must never be able to take a CRM page down.
 *
 * In production, a workspace that used its 25 monthly Tiny AI requests got a
 * 500 on /home and on every deal page. The summary and the daily brief render
 * inside server components, `assertWithinLimit` threw `PlanLimitError`, and the
 * whole render failed. The CRM data was intact and completely unreachable — the
 * first account to hit it was the owner's.
 *
 * Two things were wrong and both are fixed here:
 *
 *   1. The allowance was charged before the provider was chosen, so the offline
 *      engine — a local reasoning engine that makes no external request and
 *      costs nothing — consumed a quota meant for metered API calls.
 *   2. Any failure inside the AI path propagated out of the page.
 *
 * These tests drive the real functions. The offline provider is what production
 * actually runs today (no API key is configured), so "does the local engine
 * spend the allowance" is not a hypothetical.
 */

let A: Tenant;

describe("AI failures degrade instead of breaking the page", () => {
  after(async () => {
    await cleanupTenants([A]);
    await db.$disconnect();
  });

  async function tenant() {
    A ??= await createTenant("AiBoundary");
    return A;
  }

  test("the local engine does not spend the metered allowance", async () => {
    const t = await tenant();
    const { getRecordSummary } = await import("../../src/lib/ai/summaries");
    const { requireActor } = await import("../../src/lib/auth/access");

    const before = await db.usageCounter.findFirst({
      where: { userId: t.ownerId, metric: "ai_requests" },
      select: { count: true },
    });

    await runAsTestIdentity(t.ownerId, async () => {
      const actor = await requireActor();
      await getRecordSummary(
        actor,
        { workspaceIds: [t.workspaceId], workspaceNames: new Map([[t.workspaceId, "AiBoundary"]]) },
        "deal",
        t.dealId,
        { workspaceId: t.workspaceId, force: true },
      );
    });

    const after = await db.usageCounter.findFirst({
      where: { userId: t.ownerId, metric: "ai_requests" },
      select: { count: true },
    });
    assert.equal(
      after?.count ?? 0,
      before?.count ?? 0,
      "the offline engine charged a metered AI request; it makes no external call and must not",
    );
  });

  test("an exhausted allowance yields a summary, not a thrown error", async () => {
    const t = await tenant();
    // Put the account at its limit exactly as production was.
    await db.usageCounter.upsert({
      where: { userId_metric_period: { userId: t.ownerId, metric: "ai_requests", period: currentPeriod() } },
      update: { count: 9_999 },
      create: { userId: t.ownerId, metric: "ai_requests", period: currentPeriod(), count: 9_999 },
    });

    const { getRecordSummary } = await import("../../src/lib/ai/summaries");
    const { requireActor } = await import("../../src/lib/auth/access");

    const summary = await runAsTestIdentity(t.ownerId, async () => {
      const actor = await requireActor();
      return getRecordSummary(
        actor,
        { workspaceIds: [t.workspaceId], workspaceNames: new Map([[t.workspaceId, "AiBoundary"]]) },
        "deal",
        t.dealId,
        { workspaceId: t.workspaceId, force: true },
      );
    });

    assert.ok(summary, "the summary call returned nothing at all");
    assert.equal(typeof summary!.body, "string");
    assert.ok(summary!.body.length > 0, "a degraded summary still needs something to render");
  });

  test("the daily brief survives an exhausted allowance", async () => {
    // /home is the screen a signed-in person lands on. This is the exact path
    // that returned 500.
    const t = await tenant();
    const { getDailyBrief } = await import("../../src/lib/ai/summaries");
    const { requireActor } = await import("../../src/lib/auth/access");

    const brief = await runAsTestIdentity(t.ownerId, async () => {
      const actor = await requireActor();
      return getDailyBrief(
        actor,
        { workspaceIds: [t.workspaceId], workspaceNames: new Map([[t.workspaceId, "AiBoundary"]]) },
        { force: true },
      );
    });
    assert.ok(brief.body.length > 0, "the daily brief must render something rather than throw");
  });

  test("the metered limit itself is still enforced", async () => {
    // The fix must not have removed the limit — only stopped charging it for a
    // provider that makes no external call. `assertWithinLimit` is exactly what
    // the metered branch calls, so this asserts the control is intact.
    //
    // Stated plainly: this cannot exercise the metered branch end to end,
    // because production has no API key configured and the provider is chosen
    // from that configuration. What it does prove is that the limit still
    // throws for an exhausted account, so connecting a model later re-enables
    // enforcement rather than finding it quietly gone.
    const t = await tenant();
    const { assertWithinLimit } = await import("../../src/lib/entitlements");
    const { PlanLimitError } = await import("../../src/lib/plans");
    const { requireActor } = await import("../../src/lib/auth/access");

    await assert.rejects(
      () => runAsTestIdentity(t.ownerId, async () => assertWithinLimit(await requireActor(), "aiRequestsPerMonth")),
      (error: unknown) => error instanceof PlanLimitError,
      "the monthly AI limit no longer throws for an exhausted account",
    );
  });

  test("the metered branch is the only thing that spends the allowance", async () => {
    // Structural, and deliberately so: the ordering is the whole fix. The
    // provider must be resolved *before* the allowance is checked, or the
    // offline engine is charged again the moment someone reorders these lines.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(import.meta.dirname, "../../src/lib/ai/summaries.ts"), "utf8");
    for (const fn of ["getRecordSummary", "getDailyBrief"]) {
      const body = source.slice(source.indexOf(`export async function ${fn}`));
      const providerAt = body.search(/const provider = /);
      const assertAt = body.search(/assertWithinLimit\(/);
      assert.ok(providerAt > -1 && assertAt > -1, `${fn}: could not locate provider/limit lines`);
      assert.ok(
        providerAt < assertAt,
        `${fn} checks the allowance before choosing a provider, so the offline engine is charged`,
      );
      assert.match(body.slice(0, assertAt + 400), /metered/, `${fn} does not gate the allowance on a metered provider`);
    }
  });

});

function currentPeriod() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
