import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { summarise, RECOVERY_CAP, type ConnectionView } from "../../src/lib/integrations/status";
import { MAX_RECOVERY_ATTEMPTS } from "../../src/lib/integrations/sync/worker";

/**
 * What a connection says about itself once syncing has stopped failing
 * quietly and started failing visibly.
 *
 * "Connected" is true of a connection whose sync has failed its way to the
 * recovery cap — the token is valid and the handshake is intact. It is also
 * useless, and worse than useless on its own: it tells somebody their mail is
 * current when it may be days stale. The badge has to say otherwise.
 */

function connection(overrides: Partial<ConnectionView> = {}): ConnectionView {
  return {
    status: "connected",
    accountEmail: "someone@example.test",
    lastSyncAt: new Date("2026-10-10T09:00:00Z"),
    syncState: "idle",
    backfillCompletedAt: new Date("2026-10-01T09:00:00Z"),
    importedThrough: new Date("2026-09-10T09:00:00Z"),
    backfillTruncated: false,
    lastError: null,
    recoveryAttempts: 0,
    ...overrides,
  };
}

describe("a sync that has given up says so", () => {
  test("the cap the interface uses is the cap the scheduler uses", () => {
    // status.ts is shared with the client and cannot import the server-only
    // worker, so the number is mirrored. Mirrored numbers drift; this is what
    // stops it happening silently. If the worker's cap changes, change
    // RECOVERY_CAP with it.
    assert.equal(
      RECOVERY_CAP,
      MAX_RECOVERY_ATTEMPTS,
      "the interface and the scheduler disagree about when recovery has given up",
    );
  });

  test("below the cap, a healthy connection still reads as connected", () => {
    const summary = summarise(connection({ recoveryAttempts: RECOVERY_CAP - 1 }));
    assert.equal(summary.label, "Connected");
    assert.equal(summary.canRetrySync, undefined);
  });

  test("at the cap the badge changes, and offers something to do", () => {
    const summary = summarise(connection({ recoveryAttempts: RECOVERY_CAP }));
    assert.equal(summary.label, "Sync needs attention");
    assert.equal(summary.tone, "attention");
    assert.equal(summary.canRetrySync, true, "there is nothing the customer can press");
    assert.equal(summary.canConnect, true, "reconnecting is not offered as the next step");
    assert.ok(summary.problem, "no explanation of what to do");
  });

  test("it never claims mail is current, and never says only 'Connected'", () => {
    const summary = summarise(connection({ recoveryAttempts: RECOVERY_CAP }));
    assert.notEqual(
      summary.label,
      "Connected",
      "a connection whose sync has given up still reported a bare 'Connected'",
    );
    assert.match(
      summary.importLine ?? "",
      /Nothing new since/,
      "the import line did not say that nothing new has arrived",
    );
    // And it says what survives, because a customer reading "needs attention"
    // reasonably fears their imported mail has gone.
    assert.match(summary.importLine ?? "", /still here/);
  });

  test("past the cap reads the same as at it", () => {
    // recoveryAttempts should never exceed the cap, but a row written by an
    // older build, or by a hand-edit, must not fall through to "Connected".
    const summary = summarise(connection({ recoveryAttempts: RECOVERY_CAP + 7 }));
    assert.equal(summary.label, "Sync needs attention");
  });

  test("a connection that never synced at all says that, not 'nothing new'", () => {
    const summary = summarise(
      connection({ recoveryAttempts: RECOVERY_CAP, lastSyncAt: null }),
    );
    assert.equal(summary.label, "Sync needs attention");
    assert.match(summary.importLine ?? "", /Nothing has been imported/);
  });

  test("the attention state wins over a truncated backfill", () => {
    // Both are true at once when a resumed import then fails repeatedly. The
    // one that matters is the one where automatic progress has stopped
    // entirely; offering only "Resume import" would imply the rest is still
    // coming on its own.
    const summary = summarise(
      connection({ recoveryAttempts: RECOVERY_CAP, backfillTruncated: true }),
    );
    assert.equal(summary.label, "Sync needs attention");
    assert.equal(summary.canRetrySync, true);
  });

  test("a disconnected connection is not dressed up as needing attention", () => {
    const summary = summarise(
      connection({ status: "disconnected", recoveryAttempts: RECOVERY_CAP }),
    );
    assert.equal(summary.label, "Not connected");
    assert.equal(summary.canRetrySync, undefined, "Retry was offered on a disconnected connection");
  });

  test("the explanation never carries a provider body or a URL", () => {
    const summary = summarise(
      connection({
        recoveryAttempts: RECOVERY_CAP,
        lastError: "Could not reach the provider to refresh access. It will be retried.",
      }),
    );
    assert.ok(summary.problem);
    assert.doesNotMatch(summary.problem!, /https?:\/\//, "a URL reached the customer-facing text");
    assert.doesNotMatch(summary.problem!, /Bearer|token|eyJ/i, "a credential reached the text");
  });
});
