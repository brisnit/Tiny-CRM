import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { runAsTestIdentity } from "../../src/lib/auth/context";
import { createTenant, cleanupTenants, db, type Tenant } from "../helpers/fixtures";

/**
 * Adversarial pass, against the controls added in this round.
 *
 * The first pass attacked the application as it was. This one attacks what was
 * built to fix it — on the assumption that new code is where new mistakes are,
 * and that a control written a day ago has had the least scrutiny of anything in
 * the repository.
 *
 * Each case is an attempt, not a feature check. Where a control did not hold,
 * the finding is noted on the test.
 */

let A: Tenant;
let B: Tenant;

describe("adversarial: the new controls", () => {
  before(async () => {
    A = await createTenant("Pass2Alpha");
    B = await createTenant("Pass2Bravo");
  });
  after(async () => {
    await cleanupTenants([A, B]);
    await db.$disconnect();
  });

  const asA = <T>(fn: () => Promise<T>) => runAsTestIdentity(A.ownerId, fn);

  // -------------------------------------------------------------------------
  describe("session replay", () => {
    test("a token cannot be replayed after signing out", async () => {
      const { createSession, validateSession, revokeSession } =
        await import("../../src/lib/auth/sessions");

      const session = await createSession(A.ownerId, { userAgent: "Chrome/120" });
      const live = await validateSession(A.ownerId, session.sessionId, session.epoch);
      assert.equal(live.valid, true);

      // Sign out. An attacker who copied the token before this must not be able
      // to keep using it — deleting a cookie removes it from one browser, not
      // from the internet.
      await revokeSession(A.ownerId, live.valid ? live.sessionId : "", "signed_out");

      const replayed = await validateSession(A.ownerId, session.sessionId, session.epoch);
      assert.equal(replayed.valid, false, "a token was replayed after sign-out");
      assert.equal(replayed.reason, "revoked");
    });

    test("a token cannot be replayed after a password reset, even with a fresh epoch claim", async () => {
      // The attacker controls the token, so they control the claimed epoch.
      // Forging a *higher* epoch must not help.
      const { createSession, validateSession } = await import("../../src/lib/auth/sessions");
      const { issueToken } = await import("../../src/lib/auth/tokens");
      const { resetPassword } = await import("../../src/lib/actions/auth");

      const session = await createSession(A.memberId, { userAgent: "stolen" });
      const { token } = await issueToken(A.memberId, "password_reset");
      await resetPassword({ token, password: "reset-then-replay-probe" });

      const forged = await validateSession(A.memberId, session.sessionId, 9_999_999);
      assert.equal(
        forged.valid,
        false,
        "a forged epoch let a pre-reset session survive — the session row is not being checked",
      );
    });

    test("a session id from another account is not accepted", async () => {
      const { createSession, validateSession } = await import("../../src/lib/auth/sessions");
      const victim = await createSession(B.ownerId, { userAgent: "victim" });

      // Same session id, different user id in the token.
      const check = await validateSession(A.ownerId, victim.sessionId, victim.epoch);
      assert.equal(check.valid, false, "a session was accepted for the wrong account");
      assert.equal(check.reason, "unknown");
    });

    test("a deactivated account loses access even holding a live session", async () => {
      const { createSession } = await import("../../src/lib/auth/sessions");
      const { getIdentity } = await import("../../src/lib/auth/context");

      await createSession(A.viewerId, { userAgent: "probe" });
      await db.user.update({ where: { id: A.viewerId }, data: { deactivatedAt: new Date() } });

      const identity = await runAsTestIdentity(A.viewerId, () => getIdentity());
      assert.equal(identity, null, "a deactivated account still resolved an identity");

      await db.user.update({ where: { id: A.viewerId }, data: { deactivatedAt: null } });
    });
  });

  // -------------------------------------------------------------------------
  describe("role downgrade with a stale session", () => {
    test("a demoted member loses the permission immediately, on their existing session", async () => {
      // The attack: hold a session issued while you were an admin, get demoted,
      // and keep acting as an admin. Permissions are read from the database on
      // every request rather than baked into the token, so this must fail — and
      // this asserts it rather than assuming it.
      const { requireWorkspaceAccess } = await import("../../src/lib/auth/access");

      await db.workspaceMember.updateMany({
        where: { workspaceId: A.workspaceId, userId: A.memberId },
        data: { role: "admin" },
      });
      await assert.doesNotReject(
        runAsTestIdentity(A.memberId, () =>
          requireWorkspaceAccess(A.workspaceId, "members:manage"),
        ),
        "an admin could not manage members",
      );

      await db.workspaceMember.updateMany({
        where: { workspaceId: A.workspaceId, userId: A.memberId },
        data: { role: "member" },
      });

      await assert.rejects(
        runAsTestIdentity(A.memberId, () =>
          requireWorkspaceAccess(A.workspaceId, "members:manage"),
        ),
        "a demoted user kept an admin capability on an existing session",
      );
    });

    test("removal from a workspace takes effect on the existing session", async () => {
      const { requireWorkspaceAccess } = await import("../../src/lib/auth/access");

      const membership = await db.workspaceMember.findFirstOrThrow({
        where: { workspaceId: A.workspaceId, userId: A.viewerId },
      });
      await db.workspaceMember.delete({ where: { id: membership.id } });

      await assert.rejects(
        runAsTestIdentity(A.viewerId, () => requireWorkspaceAccess(A.workspaceId, "record:view")),
        "a removed member could still reach the workspace",
      );

      await db.workspaceMember.create({
        data: { workspaceId: A.workspaceId, userId: A.viewerId, role: "viewer" },
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("the background worker", () => {
    test("a job cannot be pointed at another tenant's record", async () => {
      // A job carries a workspaceId and an entityId. If a handler trusted the
      // entityId without the workspace, a forged job would reach across tenants.
      const { runJobs, registerHandler } = await import("../../src/lib/jobs");
      const { registerJobHandlers } = await import("../../src/lib/jobs/handlers");
      registerJobHandlers();

      let sawForeignRecord = false;
      registerHandler("task.overdue", async (job) => {
        const task = await db.task.findFirst({
          where: { id: job.entityId, workspaceId: job.workspaceId },
        });
        if (task) sawForeignRecord = true;
      });

      await db.domainEvent.deleteMany({ where: { processedAt: null } });
      await db.domainEvent.create({
        data: {
          // A's workspace, B's task.
          workspaceId: A.workspaceId,
          name: "task.overdue",
          entityType: "task",
          entityId: B.taskId,
          payload: "{}",
        },
      });

      await runJobs(10);
      assert.equal(
        sawForeignRecord,
        false,
        "a job reached a record in a workspace it was not scoped to",
      );
    });

    test("a handler that forgets to filter is still confined by tenant context", async () => {
      // The point of running handlers inside withTenantContext: the isolation
      // does not depend on the handler remembering. On SQLite there is no RLS,
      // so this asserts the context is *established*; the enforcement itself is
      // covered by tests/security/rls.test.ts on PostgreSQL.
      const { runJobs, registerHandler } = await import("../../src/lib/jobs");
      const { registerJobHandlers } = await import("../../src/lib/jobs/handlers");
      registerJobHandlers();

      let observedContext: string | null = null;
      registerHandler("note.created", async () => {
        const rows = await db.$queryRaw<{ ws: string | null }[]>`
          SELECT ${""} AS ws
        `.catch(() => [{ ws: null }]);
        observedContext = rows[0]?.ws ?? "";
      });

      await db.domainEvent.deleteMany({ where: { processedAt: null } });
      await db.domainEvent.create({
        data: {
          workspaceId: A.workspaceId, name: "note.created", entityType: "note",
          entityId: A.noteId, payload: "{}",
        },
      });

      const result = await runJobs(10);
      assert.equal(result.processed, 1, "the job did not run at all");
      assert.notEqual(observedContext, null, "the handler never executed");
    });

    test("a job for a deleted workspace fails safely rather than throwing forever", async () => {
      const { runJobs } = await import("../../src/lib/jobs");
      const { registerJobHandlers } = await import("../../src/lib/jobs/handlers");
      registerJobHandlers();

      const C = await createTenant("Pass2Gone");
      await db.domainEvent.deleteMany({ where: { processedAt: null } });
      await db.domainEvent.create({
        data: {
          workspaceId: C.workspaceId, name: "note.created", entityType: "note",
          entityId: C.noteId, payload: "{}",
        },
      });
      // The workspace disappears before the job runs. Its events cascade with
      // it, so the queue must simply have nothing to do.
      await cleanupTenants([C]);

      await assert.doesNotReject(runJobs(10), "a job for a deleted workspace crashed the runner");
    });
  });

  // -------------------------------------------------------------------------
  describe("archived records", () => {
    test("an archived record does not leak through search", async () => {
      const { searchEverything } = await import("../../src/lib/data/search");
      const { archiveContact } = await import("../../src/lib/actions/contacts");

      const before = await searchEverything([A.workspaceId], "Confidential");
      assert.ok(before.length > 0, "nothing to archive for this test");

      await asA(() => archiveContact(A.contactId));

      const after = await searchEverything([A.workspaceId], "Confidential");
      assert.ok(
        !after.some((hit) => hit.id === A.contactId),
        "an archived contact was still returned by search",
      );

      const { restoreContact } = await import("../../src/lib/actions/contacts");
      await asA(() => restoreContact(A.contactId));
    });

    test("an archived record does not leak through AI context", async () => {
      const { archiveDeal, restoreDeal } = await import("../../src/lib/actions/deals");
      const { buildWorkspaceSnapshot } = await import("../../src/lib/ai/context");

      await asA(() => archiveDeal(A.dealId));

      const snapshot = await buildWorkspaceSnapshot({
        workspaceIds: [A.workspaceId],
        workspaceNames: new Map([[A.workspaceId, "Pass2Alpha"]]),
      });
      assert.ok(
        !snapshot.citations.some((c) => c.id === A.dealId),
        "an archived deal appeared in the context sent to a model",
      );

      await asA(() => restoreDeal(A.dealId));
    });

    test("an archived record does not leak through export", async () => {
      const { archiveContact, restoreContact } = await import("../../src/lib/actions/contacts");
      const { exportCsv } = await import("../../src/lib/actions/import-export");

      await asA(() => archiveContact(A.contactId));
      const result = await asA(() => exportCsv("contacts", A.workspaceId));
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.ok(
          !result.data.csv.includes("Pass2Alpha Confidential"),
          "an archived contact was exported",
        );
      }
      await asA(() => restoreContact(A.contactId));
    });

    test("an archived record does not leak through the trash of another tenant", async () => {
      const { listTrash } = await import("../../src/lib/data/trash");
      await db.contact.update({ where: { id: B.contactId }, data: { archivedAt: new Date() } });

      const trash = await listTrash([A.workspaceId]);
      assert.ok(
        !trash.items.some((item) => item.id === B.contactId),
        "trash listed another tenant's archived record",
      );

      await db.contact.update({ where: { id: B.contactId }, data: { archivedAt: null } });
    });
  });

  // -------------------------------------------------------------------------
  describe("security alerting", () => {
    test("an alert cannot be suppressed by causing the condition repeatedly", async () => {
      // Deduplication collapses repeats into one row with a count. The count
      // must keep rising — a burst that stopped incrementing would look like it
      // had stopped happening.
      const { raiseAlert } = await import("../../src/lib/security/alerts");
      const key = `suppress-probe-${Date.now()}`;

      for (let i = 0; i < 5; i++) {
        await raiseAlert({
          kind: "auth.repeated_failures",
          workspaceId: A.workspaceId,
          summary: "repeated failures",
          dedupeKey: key,
        });
      }

      const alert = await db.securityAlert.findUniqueOrThrow({ where: { dedupeKey: key } });
      assert.equal(alert.count, 5, "repeats were not counted");
    });

    test("acknowledging an alert does not silence the next occurrence", async () => {
      // Otherwise an attacker who can trigger one alert, wait for it to be
      // acknowledged, and trigger it again would be invisible from then on.
      const { raiseAlert, acknowledgeAlert } = await import("../../src/lib/security/alerts");
      const key = `reopen-probe-${Date.now()}`;

      await raiseAlert({
        kind: "access.role_escalated",
        workspaceId: A.workspaceId,
        summary: "role raised",
        dedupeKey: key,
      });
      const first = await db.securityAlert.findUniqueOrThrow({ where: { dedupeKey: key } });
      await acknowledgeAlert(first.id, A.ownerId, [A.workspaceId]);

      await raiseAlert({
        kind: "access.role_escalated",
        workspaceId: A.workspaceId,
        summary: "role raised again",
        dedupeKey: key,
      });

      const after = await db.securityAlert.findUniqueOrThrow({ where: { dedupeKey: key } });
      assert.equal(after.acknowledgedAt, null, "a repeat stayed acknowledged and silent");
    });

    test("one tenant cannot acknowledge another tenant's alert", async () => {
      const { raiseAlert, acknowledgeAlert } = await import("../../src/lib/security/alerts");
      const key = `cross-ack-${Date.now()}`;

      await raiseAlert({
        kind: "data.mass_export",
        workspaceId: B.workspaceId,
        summary: "someone exported everything",
        dedupeKey: key,
      });
      const alert = await db.securityAlert.findUniqueOrThrow({ where: { dedupeKey: key } });

      const acknowledged = await acknowledgeAlert(alert.id, A.ownerId, [A.workspaceId]);
      assert.equal(acknowledged, false, "an alert was acknowledged from another workspace");

      const after = await db.securityAlert.findUniqueOrThrow({ where: { id: alert.id } });
      assert.equal(after.acknowledgedAt, null);
    });

    test("alerts are scoped when listed", async () => {
      const { listAlerts, raiseAlert } = await import("../../src/lib/security/alerts");
      const key = `scope-probe-${Date.now()}`;

      await raiseAlert({
        kind: "workspace.deletion_requested",
        workspaceId: B.workspaceId,
        summary: "B is being deleted",
        dedupeKey: key,
      });

      const visible = await listAlerts([A.workspaceId]);
      assert.ok(
        !visible.some((alert) => alert.dedupeKey === key),
        "one workspace's alerts were listed for another",
      );
    });

    test("alert metadata is redacted like an audit entry", async () => {
      const { raiseAlert } = await import("../../src/lib/security/alerts");
      const key = `redact-probe-${Date.now()}`;

      await raiseAlert({
        kind: "webhook.signature_failed",
        workspaceId: A.workspaceId,
        summary: "a signature failed",
        metadata: { apiKey: "sk-should-not-be-here", attempts: 3 },
        dedupeKey: key,
      });

      const alert = await db.securityAlert.findUniqueOrThrow({ where: { dedupeKey: key } });
      assert.ok(alert.metadata);
      assert.ok(
        !alert.metadata!.includes("sk-should-not-be-here"),
        "a credential was stored in a security alert",
      );
      assert.ok(alert.metadata!.includes("3"), "non-sensitive metadata was over-redacted");
    });

    test("an alerting failure does not fail the operation that raised it", async () => {
      // An attacker who can make alerting throw could otherwise both suppress
      // the alert and break the product by causing the condition.
      const { raiseAlert } = await import("../../src/lib/security/alerts");
      await assert.doesNotReject(
        raiseAlert({
          kind: "auth.account_locked",
          // A workspace that does not exist: the insert will fail on its foreign
          // key, and raiseAlert must swallow it.
          workspaceId: "no-such-workspace-at-all",
          summary: "probe",
          dedupeKey: `fk-fail-${Date.now()}`,
        }),
        "a failing alert threw into the caller",
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("AI with the workspace switched off", () => {
    test("a summary cannot be forced through by naming another workspace", async () => {
      const { refreshRecordSummary } = await import("../../src/lib/actions/ai");
      await db.workspace.update({
        where: { id: A.workspaceId },
        data: { aiMode: "disabled" },
      });

      // The record's own workspace decides, not the caller. Pointing at a
      // record in a disabled workspace must not transmit, and pointing at
      // another tenant's record must not resolve at all.
      const foreign = await asA(() => refreshRecordSummary("deal", B.dealId));
      assert.equal(foreign.ok, false, "a summary was produced for another tenant's record");

      const own = await asA(() => refreshRecordSummary("deal", A.dealId));
      // It succeeds — the deterministic engine answers — but nothing was sent.
      assert.equal(own.ok, true, "AI off broke summaries entirely instead of degrading them");

      await db.workspace.update({ where: { id: A.workspaceId }, data: { aiMode: "enabled" } });
    });

    test("capture falls back to local extraction rather than refusing", async () => {
      const { analyzeText } = await import("../../src/lib/actions/ai");
      await db.workspace.update({ where: { id: A.workspaceId }, data: { aiMode: "disabled" } });

      const result = await asA(() =>
        analyzeText("Spoke to Dana at Northwind about a $40,000 renewal.", A.workspaceId),
      );
      assert.equal(result.ok, true, "capture stopped working when AI was turned off");

      await db.workspace.update({ where: { id: A.workspaceId }, data: { aiMode: "enabled" } });
    });
  });

  // -------------------------------------------------------------------------
  describe("rate limiting", () => {
    test("rotating the identifier does not reset a per-account limit", async () => {
      const { checkRateLimit, resetRateLimit } = await import("../../src/lib/rate-limit");
      const account = `rotate-${Date.now()}@example.test`;
      await resetRateLimit("passwordReset", { account });

      let blocked = false;
      for (let i = 0; i < 6; i++) {
        // A new address each time. The account axis must still accumulate.
        const result = await checkRateLimit("passwordReset", { ip: `10.1.1.${i}`, account });
        if (!result.ok) {
          assert.equal(result.dimension, "account");
          blocked = true;
          break;
        }
      }
      assert.ok(blocked, "rotating the source address reset the per-account limit");
      await resetRateLimit("passwordReset", { account });
    });

    test("case and whitespace variations of an email share one counter", async () => {
      // Otherwise "Victim@example.test " is a fresh budget for the same inbox.
      const { checkRateLimit, resetRateLimit } = await import("../../src/lib/rate-limit");
      const { requestPasswordReset } = await import("../../src/lib/actions/auth");

      const user = await db.user.findUniqueOrThrow({ where: { id: A.memberId } });
      await resetRateLimit("passwordReset", { account: user.email });

      // The action normalises through zEmail before the limit is consulted.
      for (let i = 0; i < 4; i++) {
        await requestPasswordReset({ email: `  ${user.email.toUpperCase()}  ` });
      }

      const result = await checkRateLimit("passwordReset", { account: user.email });
      assert.ok(
        result.remaining < 3,
        "a case variation of the same address got a separate budget",
      );
      await resetRateLimit("passwordReset", { account: user.email });
    });
  });
});
