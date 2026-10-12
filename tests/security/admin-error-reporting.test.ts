import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

/**
 * What the error tracker is told about an admin refusal.
 *
 * ## The incident this is the regression test for
 *
 * Sentry TINY-CRM-8: `AppError "Not found" on GET /admin`, release 473d353.
 * `requirePlatformAdmin()` threw an `AppError` on refusal. A server action
 * catches that and returns a structured failure, but a server *component* has
 * nothing to catch it, so the refusal escaped to Next's `onRequestError` hook —
 * which logs at error level and reports to the tracker. An ordinary account
 * opening `/admin`, which is precisely what the refusal exists for, therefore
 * raised an application-error alert and answered **500 with an empty body**
 * rather than the 404 it was meant to look like.
 *
 * Nothing was ever exposed. What was wrong was the status and the alert.
 *
 * ## What is asserted, and what is deliberately not
 *
 * No error category is suppressed and no route is exempted. The expected
 * refusal stops being an exception at all — pages use Next's own `notFound()`
 * control flow — so there is nothing to report. These tests pin that, and pin
 * the two things that must NOT change with it: a mis-bound administrator is
 * still reported, and an ordinary fault is still reported even on `/admin`.
 *
 * The adapter is replaced through `globalThis.observability`, which
 * src/lib/observability.ts memoises on first import. It is installed here
 * before anything imports that module, which holds because node:test runs each
 * file in its own process.
 */

import { db, createTenant, cleanupTenants } from "../helpers/fixtures";
import { runAsTestIdentity } from "../../src/lib/auth/context";
import { requirePlatformAdmin, requirePlatformAdminPage } from "../../src/lib/admin/authorize";
import { AppError } from "../../src/lib/errors";
import { onRequestError } from "../../src/instrumentation";

type Captured = { message: string; route?: string };
const captured: Captured[] = [];

/**
 * The seam. src/lib/observability.ts memoises its adapter on `globalThis` the
 * first time it is imported, and every import of it in the codebase is dynamic
 * — `src/instrumentation.ts` and `requirePlatformAdminPage`'s drift report are
 * the only two — so installing this in `before()` is early enough. Verified by
 * grep rather than assumed, because if the real adapter won in this process
 * these assertions would pass while reporting nothing.
 */
const globalForObservability = globalThis as unknown as { observability?: unknown };

function installAdapter(): void {
  globalForObservability.observability = {
    kind: "test",
    captureError: async (error: unknown, context: { route?: string }) => {
      captured.push({
        message: error instanceof Error ? error.message : String(error),
        route: context?.route,
      });
    },
    recordSpan: async () => {},
  };
}

type Tenant = Awaited<ReturnType<typeof createTenant>>;

let admin: Tenant;
let ordinary: Tenant;
let adminEmail = "";

before(async () => {
  installAdapter();
  admin = await createTenant("ReportAdmin", { plan: "free" });
  ordinary = await createTenant("ReportOrdinary", { plan: "free" });
  adminEmail = (
    await db.user.findUniqueOrThrow({ where: { id: admin.ownerId }, select: { email: true } })
  ).email;
  await db.platformAdmin.create({
    data: { userId: admin.ownerId, boundEmail: adminEmail, note: "reporting test" },
  });
});

after(async () => {
  await db.platformAdmin.deleteMany({ where: { userId: { in: [admin.ownerId, ordinary.ownerId] } } });
  await cleanupTenants([admin, ordinary]);
  await db.$disconnect();
});

/** Next's 404 control flow carries a digest; an uncaught fault does not. */
function isNextNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    String((error as { digest: unknown }).digest).includes("404")
  );
}

async function thrownBy(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

describe("an expected admin refusal is not an application error", () => {
  test("a page refusal is Next's 404 control flow, and reports nothing", async () => {
    captured.length = 0;
    const error = await thrownBy(() =>
      runAsTestIdentity(ordinary.ownerId, () => requirePlatformAdminPage()),
    );
    assert.ok(error, "the refusal did not throw at all, which would expose the panel");
    assert.ok(
      isNextNotFound(error),
      `expected Next's 404 control flow, got ${(error as Error)?.name}: ${(error as Error)?.message}`,
    );
    assert.ok(
      !(error instanceof AppError),
      "still an AppError, so it would still escape to onRequestError as a 500",
    );
    assert.deepEqual(captured, [], "an expected refusal was reported to the error tracker");
  });

  test("the restriction is unchanged: the action path still refuses, and says nothing", async () => {
    const error = await thrownBy(() =>
      runAsTestIdentity(ordinary.ownerId, () => requirePlatformAdmin()),
    );
    assert.ok(error instanceof AppError, "the action guard no longer throws an AppError");
    assert.equal(error.category, "not_found", "the refusal stopped being a 'not found'");
    assert.equal(error.message, "Not found.");
    assert.doesNotMatch(
      error.message,
      /admin|forbidden|permission/i,
      "the message discloses that an administrative surface exists",
    );
  });

  test("the bound admin still gets through, so this did not lock the panel", async () => {
    const actor = await runAsTestIdentity(admin.ownerId, () => requirePlatformAdminPage());
    assert.equal(actor.platformAdmin, true);
    assert.equal(actor.identity.id, admin.ownerId);
  });
});

describe("the unexpected cases still alert", () => {
  test("a bound administrator whose address no longer matches is reported", async () => {
    // The one failure here that is nobody's expected refusal: the panel is
    // unreachable until an operator re-binds, and nothing else in the product
    // would say so. Before this change the tracker could not tell it apart
    // from an ordinary probe — both threw the same line, and `internal` is not
    // in the payload allowlist.
    captured.length = 0;
    await db.platformAdmin.update({
      where: { userId: admin.ownerId },
      data: { boundEmail: `changed-${adminEmail}` },
    });
    try {
      const error = await thrownBy(() =>
        runAsTestIdentity(admin.ownerId, () => requirePlatformAdminPage()),
      );
      assert.ok(isNextNotFound(error), "the admin was not answered with a 404");
      // The report is fire-and-forget by design — reporting must not be what
      // breaks a refusal — so give the microtask queue a turn.
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(captured.length, 1, "a mis-bound administrator was not reported");
      assert.match(captured[0].message, /binding no longer matches/i);
      assert.match(captured[0].message, /re-bind/i);
      // And nothing identifying in what leaves the process.
      assert.doesNotMatch(captured[0].message, new RegExp(adminEmail, "i"),
        "the bound address was sent to the error tracker");
    } finally {
      await db.platformAdmin.update({
        where: { userId: admin.ownerId },
        data: { boundEmail: adminEmail },
      });
    }
  });

  test("an ordinary fault on /admin is still reported — nothing about the route is exempt", async () => {
    captured.length = 0;
    await onRequestError(
      new Error("the customer directory query blew up"),
      { path: "/admin", method: "GET" },
      { routePath: "/admin", routeType: "render" },
    );
    assert.equal(captured.length, 1, "a real fault on /admin stopped being reported");
    assert.match(captured[0].message, /blew up/);
    assert.equal(captured[0].route, "/admin");
  });

  test("and so is an AppError that genuinely escapes — no category is suppressed", async () => {
    // Proving the fix was not a filter. If a not_found ever does escape from
    // somewhere that has no 404 control flow, it still reports.
    captured.length = 0;
    await onRequestError(
      new AppError("not_found", "Not found."),
      { path: "/admin", method: "GET" },
      { routePath: "/admin", routeType: "render" },
    );
    assert.equal(captured.length, 1, "AppError reporting was suppressed wholesale");
  });
});
