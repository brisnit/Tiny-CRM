import "server-only";

/**
 * What to tell a customer about a connection, in words that do not overstate.
 *
 * ## Connected is not synced, and the distinction is the whole point
 *
 * A completed OAuth handshake means we hold a token. It does not mean a single
 * message or meeting exists in the CRM — that happens when the sync worker
 * runs, which in this release it never does. Saying "Connected" and leaving it
 * there invites exactly the wrong conclusion, so every connected state also
 * says where the import stands:
 *
 *   connected, never synced   → "Connected · nothing imported yet"
 *   connected, backfilling    → "Connected · importing…"
 *   connected, synced         → "Connected · last imported <when>"
 *
 * The third line is the only one that may claim data exists, and it is driven
 * by `lastSyncAt`, which only the worker writes.
 */

export type ConnectionView = {
  status: string;
  accountEmail: string | null;
  lastSyncAt: Date | null;
  syncState: string;
  backfillCompletedAt: Date | null;
  /** How far back the import actually reached. */
  importedThrough: Date | null;
  /** The page cap stopped it before the end of the window. */
  backfillTruncated: boolean;
  lastError: string | null;
  /** Consecutive automatic recoveries since the last pass that completed. */
  recoveryAttempts: number;
};

export type ConnectionSummary = {
  /** The badge. Never "Connected" unless a live token is held. */
  label: string;
  tone: "connected" | "attention" | "demo" | "none";
  /** The second line: what has actually been imported. Null when not connected. */
  importLine: string | null;
  /** Something the customer can act on, or null. */
  problem: string | null;
  canConnect: boolean;
  canDisconnect: boolean;
  /** Offer to continue an import the cap stopped. */
  canResume?: boolean;
  /**
   * Offer to start syncing again after automatic recovery gave up.
   *
   * Distinct from `canResume`: that continues a backfill the page cap stopped
   * deliberately, which is a complete import of a smaller window. This is a
   * sync that kept failing, where what was imported may be stale by an
   * unknown amount.
   */
  canRetrySync?: boolean;
};

/**
 * The recovery cap, mirrored from the worker.
 *
 * Imported rather than re-declared would be better, but this module is shared
 * with the client and the worker is `server-only`. The number is asserted
 * against the real one in tests/unit so the two cannot drift silently.
 */
export const RECOVERY_CAP = 3;

/** A date alone, for "imported back to …", where a time would be noise. */
function day(date: Date | null): string {
  if (!date) return "an unknown date";
  return date.toISOString().slice(0, 10);
}

function when(date: Date | null): string {
  if (!date) return "never";
  return date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function summarise(connection: ConnectionView | null): ConnectionSummary {
  if (!connection) {
    return {
      label: "Not connected",
      tone: "none",
      importLine: null,
      problem: null,
      canConnect: true,
      canDisconnect: false,
    };
  }

  switch (connection.status) {
    case "mock":
      // Seeded demonstration data. Says so, and offers no disconnect, because
      // there is nothing connected to disconnect from.
      return {
        label: "Demo data — not a real connection",
        tone: "demo",
        importLine: "Example messages, so the contact and project pages have something to show.",
        problem: null,
        canConnect: true,
        canDisconnect: false,
      };

    case "connected": {
      // Four honest readings of a live connection, and the order matters: an
      // incomplete import must not be reported as a finished one just because
      // something was imported.
      let importLine: string;
      let problem: string | null = null;

      // Checked before everything else, because it is the one reading that
      // contradicts the badge. A connection whose sync has failed its way to
      // the recovery cap still holds a valid token — "Connected" is true and
      // useless, and on its own it tells the customer their mail is current
      // when it may be days stale. The badge says so instead.
      if (connection.recoveryAttempts >= RECOVERY_CAP) {
        return {
          label: "Sync needs attention",
          tone: "attention",
          importLine: connection.lastSyncAt
            ? `Nothing new since ${when(connection.lastSyncAt)}. Anything already ` +
              `imported is still here.`
            : "Nothing has been imported.",
          problem:
            connection.lastError ??
            "Importing stopped and could not restart on its own. Retry it, or reconnect " +
              "the account if retrying does not help.",
          canConnect: true,
          canDisconnect: true,
          canRetrySync: true,
        };
      }

      if (connection.backfillTruncated) {
        // The cap stopped it. Saying how far it reached and that there is more
        // is the whole point — "imported" must never mean more than it did.
        importLine =
          `Imported back to ${day(connection.importedThrough)}, and stopped there. ` +
          `There is older mail in the window that has not been imported.`;
        problem = "This import is incomplete. Resume it to continue from where it stopped.";
      } else if (connection.syncState === "backfilling") {
        importLine = connection.importedThrough
          ? `Importing now — back to ${day(connection.importedThrough)} so far.`
          : "Importing your recent mail and meetings now.";
      } else if (connection.lastSyncAt && connection.backfillCompletedAt) {
        importLine =
          `Imported back to ${day(connection.importedThrough)}. ` +
          `Last checked ${when(connection.lastSyncAt)}.`;
      } else {
        importLine = "Nothing imported yet — importing has not started.";
      }

      return {
        label: "Connected",
        tone: connection.backfillTruncated ? "attention" : "connected",
        importLine,
        problem,
        canConnect: false,
        canDisconnect: true,
        canResume: connection.backfillTruncated === true,
      };
    }

    case "reauth_required":
      return {
        label: "Reconnect needed",
        tone: "attention",
        importLine: "Importing has stopped. Anything already imported is still here.",
        problem:
          connection.lastError ??
          "Access was revoked or has expired. Reconnect to resume importing.",
        canConnect: true,
        canDisconnect: true,
      };

    case "error":
      return {
        label: "Needs attention",
        tone: "attention",
        importLine: connection.lastSyncAt
          ? `Last imported ${when(connection.lastSyncAt)}.`
          : "Nothing imported yet.",
        problem: connection.lastError ?? "Something went wrong. It will be retried.",
        canConnect: true,
        canDisconnect: true,
      };

    case "disconnected":
      return {
        label: "Not connected",
        tone: "none",
        importLine: null,
        problem: null,
        canConnect: true,
        canDisconnect: false,
      };

    default:
      // An unrecognised stored status reads as not connected rather than being
      // rendered raw, so an internal value cannot leak into the interface.
      return {
        label: "Not connected",
        tone: "none",
        importLine: null,
        problem: null,
        canConnect: true,
        canDisconnect: false,
      };
  }
}

/** The banner after a redirect back from a provider. */
export const CALLBACK_MESSAGES: Record<string, { tone: "ok" | "warn"; text: string }> = {
  connected: {
    tone: "ok",
    text:
      "Connected. Nothing has been imported yet — importing runs separately, and this page " +
      "will say when it has.",
  },
  declined: { tone: "warn", text: "You cancelled at the permission screen, so nothing was connected." },
  incomplete: {
    tone: "warn",
    text:
      "Some permissions were not granted, so this could not sync. Connect again and accept all " +
      "of them.",
  },
  "wrong-organisation": {
    tone: "warn",
    text: "That account belongs to a different organisation, so it was not connected.",
  },
  plan: { tone: "warn", text: "Connecting email and calendar is a Pro feature." },
  unavailable: { tone: "warn", text: "That connection is not available yet." },
  invalid: { tone: "warn", text: "That connection attempt could not be verified. Please start again." },
  failed: { tone: "warn", text: "That connection could not be completed. Please try again." },
  resuming: {
    tone: "ok",
    text: "Continuing the import from where it stopped. This page will say when it has.",
  },
  "nothing-to-resume": {
    tone: "warn",
    text: "There is nothing to resume — that import is not incomplete.",
  },
  retrying: {
    tone: "ok",
    text:
      "Trying again. This page will say when something has been imported — if it stops " +
      "again, reconnecting the account is the next step.",
  },
  "retry-refused": {
    tone: "warn",
    text:
      "That could not be retried. The connection is no longer in a state where syncing can " +
      "start — reconnect the account.",
  },
};
