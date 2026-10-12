import "server-only";

import { notFound } from "next/navigation";

import { getActor, type Actor } from "@/lib/auth/access";
import { AppError, unauthorized } from "@/lib/errors";
import { log } from "@/lib/logger";
import { withTenantContext } from "@/lib/tenant-db";

/**
 * Who may operate the owner-admin panel.
 *
 * ## The binding is an identity, not an address
 *
 * Authorization is a row in `PlatformAdmin` keyed by **user id**. It is never
 * derived from an email, and that distinction is the whole point: an address
 * is something a browser supplies and something a new registration can choose.
 * Binding to the id means the account that holds administration is the account
 * that held it when the row was written, whatever anyone later signs up as.
 *
 * The email is still checked, as a second condition rather than the first. It
 * costs one comparison on a row already loaded, and it turns "the id was
 * reused or mistyped at migration time" from a silent grant into a refusal.
 * Both must match; neither alone is sufficient.
 *
 * ## Why this is not an environment variable
 *
 * The row-level-security policy that lets an admin read across tenants has to
 * consult the same fact, and a policy cannot read `process.env`. One source of
 * truth, in the database, consulted by both — rather than two that can drift,
 * where the drift that matters is the application believing someone is an admin
 * while the database does not, or worse, the reverse.
 *
 * What this does **not** defend against: arbitrary SQL execution. The policy
 * resolves administration from `app.user_id`, which is trusted application
 * context — anything able to run statements as the application role can set it
 * to any value. That is true of every policy in the schema, since they all read
 * the same setting. RLS isolates tenants from each other through the
 * application; it is not a second line of defence behind the application being
 * compromised.
 *
 * And be precise about the table's value, because the obvious reading is
 * wrong: someone executing arbitrary SQL as the application role can set
 * `app.user_id` to an existing administrator's id and be treated as that
 * administrator. No write is needed, and `PlatformAdmin` does not prevent it.
 * What it prevents is the *appointment of a new administrator at runtime* —
 * there is no INSERT policy, so membership cannot be created through the
 * application role by any means. An attacker at that level can impersonate an
 * admin who exists; they cannot mint one.
 *
 * ## Deny by default
 *
 * Every function here throws. There is no boolean variant that a caller can
 * forget to branch on, except `isPlatformAdmin`, which exists only for
 * rendering the navigation link and is named so that using it as a gate reads
 * as wrong.
 */

export type PlatformAdminActor = Actor & {
  /** Present only on an actor that has passed the check. */
  readonly platformAdmin: true;
};

/**
 * The admin row for a user id, or null.
 *
 * Runs inside a tenant context carrying **the user id and no workspaces**, and
 * that is load-bearing rather than incidental. `PlatformAdmin` is under RLS
 * with a single `FOR SELECT` policy admitting only `"userId" = app_user_id()`,
 * and `app.user_id` is set by `withTenantContext` — so a read without it
 * returns nothing.
 *
 * An earlier version used `withoutTenantContext`, which sets no user id. On
 * SQLite, where there is no RLS, it passed. On PostgreSQL it would have
 * refused every administrator including the owner: the check and the policy
 * disagreed, and only one of the two engines showed it. Hence the empty
 * workspace list rather than no context at all — this read needs an identity,
 * not a tenancy.
 */
async function adminRowFor(
  userId: string,
): Promise<{ userId: string; boundEmail: string } | null> {
  return withTenantContext(
    { workspaceIds: [], userId, restrictedWorkspaceIds: [] },
    async (tx) =>
      tx.platformAdmin.findUnique({
        where: { userId },
        select: { userId: true, boundEmail: true },
      }),
  );
}

/**
 * Both conditions, in one place.
 *
 * The id is the binding. The address is a second condition that can only
 * **deny** — it never grants anything, and it cannot transfer administration
 * to anyone, because the row is found by id and an account that later takes
 * this address has a different id.
 *
 * What it catches is a mis-bound id: a real account, the wrong one, silently
 * holding the panel because a character was wrong when the row was written.
 * Without the comparison that is undetectable from inside the product.
 *
 * The cost is honest and documented: if the owner changes their email,
 * administration stops working until an operator re-binds. That is the safer
 * of the two failures, and `scripts/bind-platform-admin.mjs` is the remedy.
 */
function bindingHolds(
  row: { boundEmail: string } | null,
  currentEmail: string,
): row is { userId: string; boundEmail: string } {
  if (!row) return false;
  return row.boundEmail.trim().toLowerCase() === currentEmail.trim().toLowerCase();
}

/**
 * True when the current session belongs to a platform admin.
 *
 * For deciding whether to *render* something. Never for deciding whether to
 * allow something — use `requirePlatformAdmin`, which throws, so that a
 * forgotten `if` is a crash rather than an open door.
 */
export async function isPlatformAdmin(): Promise<boolean> {
  const actor = await getActor();
  if (!actor) return false;
  const row = await adminRowFor(actor.identity.id);
  return bindingHolds(row, actor.identity.email);
}

/**
 * Asserts that the caller is the platform admin, and returns the actor.
 *
 * Called by every admin page, every admin server action and every admin route
 * handler — there is no layout-level check standing in for it, because a layout
 * does not run for a server action and a reader cannot tell from an action's
 * source whether something upstream protected it.
 */
export async function requirePlatformAdmin(): Promise<PlatformAdminActor> {
  const outcome = await checkPlatformAdmin();
  if (outcome.ok) return outcome.actor;
  if (outcome.kind === "unauthenticated") throw unauthorized();

  if (outcome.kind === "binding_drift") reportBindingDrift(outcome);
  // "Not found" rather than "forbidden", for the same reason the rest of the
  // codebase does: confirming that an administrative surface exists is itself
  // a disclosure to someone who should not know.
  throw new AppError("not_found", "Not found.", { internal: internalFor(outcome) });
}

/**
 * The same decision, for a **page** rather than an action.
 *
 * Why this exists, precisely. `requirePlatformAdmin` throws an `AppError`,
 * which a server action catches and turns into a structured failure. A server
 * *component* has nothing to catch it, so the throw escaped to Next's
 * `onRequestError` hook, which logs at error level and reports to the error
 * tracker. An ordinary account opening `/admin` — the exact thing the refusal
 * is for — therefore raised an application-error alert and returned **500 with
 * an empty body**, not the 404 it was supposed to look like. Both halves of
 * that were confirmed by driving a real browser: `PROBE_STATUS=500`.
 *
 * `notFound()` is Next's own control flow. It renders the 404 that was always
 * intended, and it is not an uncaught error, so nothing reports it. No
 * reporting rule was relaxed to achieve that and no error category is
 * suppressed: an expected refusal simply stops being an exception, while a real
 * fault inside `/admin` still reports exactly as before.
 *
 * The one case that is *not* expected keeps alerting, and now does so
 * distinguishably: a `PlatformAdmin` row whose `boundEmail` no longer matches
 * the account is a misconfiguration an operator has to fix, and it is reported
 * explicitly before the 404. The error tracker could not previously tell the
 * two apart — both threw this same line, and `internal` is not in the payload
 * allowlist.
 */
export async function requirePlatformAdminPage(): Promise<PlatformAdminActor> {
  const outcome = await checkPlatformAdmin();
  if (outcome.ok) return outcome.actor;
  if (outcome.kind === "unauthenticated") throw unauthorized();

  if (outcome.kind === "binding_drift") reportBindingDrift(outcome);
  else {
    // Observable without being an alert: a refused probe of an administrative
    // surface is worth being able to find, and is not a fault.
    log.warn("platform admin refused", { userId: outcome.userId });
  }
  notFound();
}

/** What the check decided, so each caller can answer in its own idiom. */
type AdminOutcome =
  | { ok: true; actor: PlatformAdminActor }
  | { ok: false; kind: "unauthenticated" }
  | { ok: false; kind: "not_admin"; userId: string }
  | { ok: false; kind: "binding_drift"; userId: string; boundTo: string; currentEmail: string };

async function checkPlatformAdmin(): Promise<AdminOutcome> {
  const actor = await getActor();
  // No session at all: the same answer an ordinary protected page gives.
  if (!actor) return { ok: false, kind: "unauthenticated" };

  const row = await adminRowFor(actor.identity.id);
  // Read before the guard: `bindingHolds` is a type predicate, so in its
  // negated branch TypeScript narrows `row` to `never` and the address is no
  // longer reachable through it.
  const boundTo = row?.boundEmail ?? null;
  if (bindingHolds(row, actor.identity.email)) {
    return { ok: true, actor: Object.assign(actor, { platformAdmin: true as const }) };
  }
  if (boundTo !== null) {
    return {
      ok: false,
      kind: "binding_drift",
      userId: actor.identity.id,
      boundTo,
      currentEmail: actor.identity.email,
    };
  }
  return { ok: false, kind: "not_admin", userId: actor.identity.id };
}

function internalFor(outcome: Extract<AdminOutcome, { ok: false }>): string {
  if (outcome.kind === "binding_drift") {
    return (
      `platform admin bound for ${outcome.boundTo} but the account is now ` +
      `${outcome.currentEmail}; re-bind with scripts/bind-platform-admin.mjs`
    );
  }
  return `platform admin refused for user ${"userId" in outcome ? outcome.userId : "unknown"}`;
}

/**
 * A bound administrator who can no longer get in. Not an expected refusal.
 *
 * Reported rather than merely logged, because the panel is unreachable until
 * somebody re-binds and nothing else in the product will say so. The addresses
 * go to the log only; the tracker receives the message this builds, and
 * `scrubMessage` in src/lib/observability.ts strips anything that looks like
 * quoted data from it.
 */
function reportBindingDrift(
  outcome: Extract<AdminOutcome, { kind: "binding_drift" }>,
): void {
  log.error("platform admin binding no longer matches the account", {
    userId: outcome.userId,
    boundTo: outcome.boundTo,
    currentEmail: outcome.currentEmail,
  });
  void import("@/lib/observability").then(({ captureError }) =>
    captureError(
      new Error(
        "platform admin binding no longer matches the bound address; " +
          "re-bind with scripts/bind-platform-admin.mjs",
      ),
      { route: "/admin", operation: "requirePlatformAdmin" },
    ),
  ).catch(() => {
    // Reporting must never be what breaks the refusal.
  });
}

/**
 * The accounts an admin may not act on: their own.
 *
 * Suspending yourself locks you out of the panel that would reinstate you, and
 * revoking your own administration cannot be undone from inside the product.
 * Both are refused rather than confirmed, because a confirmation dialog is not
 * a safeguard against a mistake you are about to make deliberately.
 */
export function refuseSelfTarget(actor: Actor, targetUserId: string, what: string): void {
  if (actor.identity.id === targetUserId) {
    throw new AppError("validation", `You cannot ${what} your own account.`);
  }
}
