import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { createTenant, cleanupTenants, type Tenant } from "../helpers/fixtures";
import { requireFileUploadEntitlement } from "../../src/lib/entitlements";
import { planGrants } from "../../src/lib/plans";
import { withTenantContext } from "../../src/lib/tenant-db";

/**
 * File uploads are a paid capability, and now something reads that.
 *
 * `PlanCapabilities.fileUploads` has existed since the plan matrix was written
 * — `false` on Free, `true` on Plus and Pro — and **nothing ever read it**.
 * `planGrants` was called in exactly one place, for `documentQa`. The capability
 * looked enforced only because the `files` feature flag defaults to `false`, so
 * no account had uploads at all and the gap could not be observed.
 *
 * Turning `files` on globally is what rolling out Document Intelligence
 * involves, and that is the moment the gap becomes a pricing bug: the public
 * pricing page sells "File attachments on any record" as Plus, and a Free
 * account would have had it.
 *
 * These tests run on SQLite as well as PostgreSQL deliberately. The check is a
 * plan lookup, not an isolation property, so there is no reason for it to be
 * invisible in the fast suite — which is where the original omission would have
 * been caught.
 */

let free: Tenant;
let plus: Tenant;
let pro: Tenant;
let lifetime: Tenant;

before(async () => {
  free = await createTenant("UploadFree", { plan: "free" });
  plus = await createTenant("UploadPlus", { plan: "plus" });
  pro = await createTenant("UploadPro", { plan: "pro" });
  lifetime = await createTenant("UploadLifetime", { plan: "legacy_lifetime" });
});

after(async () => {
  await cleanupTenants([free, plus, pro, lifetime]);
});

/** Inside a context the workspace is visible from, as every caller is. */
async function check(tenant: Tenant): Promise<{ ok: boolean; message?: string }> {
  return withTenantContext(
    { workspaceIds: [tenant.workspaceId], userId: tenant.ownerId, restrictedWorkspaceIds: [] },
    async () => {
      try {
        await requireFileUploadEntitlement(tenant.workspaceId);
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  );
}

describe("the plan half of the upload gate", () => {
  test("Free is refused, and told what to do about it", async () => {
    const result = await check(free);
    assert.equal(result.ok, false, "a Free workspace was allowed to upload");
    assert.match(
      result.message ?? "",
      /Plus feature/i,
      "the refusal did not name the plan that includes uploads",
    );
    // No internal detail: this message is shown to a customer.
    assert.doesNotMatch(result.message ?? "", /flag|workspaceId|plan_limit/i);
  });

  test("Plus is allowed", async () => {
    assert.equal((await check(plus)).ok, true, "Plus pays for file attachments and was refused");
  });

  test("Pro is allowed", async () => {
    assert.equal((await check(pro)).ok, true, "Pro was refused");
  });

  test("a legacy Lifetime account keeps uploads", async () => {
    // Entitlements for legacy plans are preserved exactly; a rollout must not
    // quietly take a capability away from an account that already had it.
    assert.equal(
      planGrants("legacy_lifetime", "fileUploads"),
      true,
      "the legacy plan matrix no longer grants uploads",
    );
    assert.equal((await check(lifetime)).ok, true, "a Lifetime account was refused uploads");
  });

  test("an unknown plan is refused rather than defaulted upward", async () => {
    assert.equal(planGrants("something-we-never-shipped", "fileUploads"), false);
    assert.equal(planGrants(null, "fileUploads"), false);
    assert.equal(planGrants(undefined, "fileUploads"), false);
  });

  test("a workspace that is not visible from this context is refused", async () => {
    // Fails closed. The alternative is granting a paid capability because a read
    // came back empty, which is the direction that costs money rather than
    // annoying somebody.
    const result = await withTenantContext(
      { workspaceIds: [pro.workspaceId], userId: pro.ownerId, restrictedWorkspaceIds: [] },
      async () => {
        try {
          await requireFileUploadEntitlement("cl00000000000000000000000");
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },
    );
    assert.equal(result.ok, false, "a nonexistent workspace was treated as entitled");
  });
});

describe("the gate is wired into the upload path, and only there", () => {
  test("both upload steps call it; preview, download and delete do not", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/lib/actions/files.ts"), "utf8");

    const calls = [...source.matchAll(/requireFileUploadEntitlement\(/g)].length;
    assert.equal(
      calls,
      2,
      "expected the entitlement check on exactly the two upload steps — " +
        "requestUpload and confirmUpload. An account that downgrades must keep " +
        "reading and deleting what it already stored.",
    );

    // Named rather than positional, so this keeps meaning if the file moves.
    for (const fn of ["deleteFile", "requestDocumentPreview"]) {
      const start = source.indexOf(`export async function ${fn}`);
      assert.ok(start > -1, `${fn} is no longer exported from files.ts`);
      const body = source.slice(start, start + 3000);
      assert.doesNotMatch(
        body,
        /requireFileUploadEntitlement/,
        `${fn} must not require the upload entitlement — a downgraded account ` +
          "still needs to read and remove its own documents",
      );
    }
  });
});

describe("ingestion starts without waiting for cron", () => {
  test("the upload confirmation drains the outbox", async () => {
    /**
     * Measured, not assumed. With no `dispatchSoon()` here the `file.uploaded`
     * event sat `pending` with `attempts: 0` through twenty page loads of the
     * project it belonged to, because only projects, deals and tasks drained the
     * queue and a GET drains nothing. Production cron runs every 30 minutes, so
     * a customer could upload a contract, ask a question about it, and be told
     * "I haven't been able to read it yet" for half an hour.
     *
     * The outbox plus `/api/cron/jobs` is still the delivery guarantee. This is
     * the latency, and it is asserted at the call site because the alternative —
     * driving a real upload — needs PostgreSQL and an object store, which is
     * exactly the combination that let the omission go unnoticed.
     */
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(process.cwd(), "src/lib/actions/files.ts"), "utf8");

    const emitAt = source.indexOf('name: "file.uploaded"');
    assert.ok(emitAt > -1, "files.ts no longer emits file.uploaded");

    const after = source.slice(emitAt);
    const dispatchAt = after.indexOf("dispatchSoon()");
    assert.ok(
      dispatchAt > -1,
      "nothing drains the outbox after an upload, so ingestion waits for the " +
        "next cron tick — up to 30 minutes on the production schedule",
    );
    assert.ok(
      dispatchAt < 2000,
      "dispatchSoon() is too far from the emit to be dispatching this event",
    );
  });
});
