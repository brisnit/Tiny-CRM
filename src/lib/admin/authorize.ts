import "server-only";

import { getActor, type Actor } from "@/lib/auth/access";
import { AppError, unauthorized } from "@/lib/errors";
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
async function adminRowFor(userId: string): Promise<{ userId: string } | null> {
  return withTenantContext(
    { workspaceIds: [], userId, restrictedWorkspaceIds: [] },
    async (tx) => tx.platformAdmin.findUnique({ where: { userId }, select: { userId: true } }),
  );
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
  return Boolean(row);
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
  const actor = await getActor();
  // No session at all: the same answer an ordinary protected page gives.
  if (!actor) throw unauthorized();

  const row = await adminRowFor(actor.identity.id);
  if (!row) {
    // "Not found" rather than "forbidden", for the same reason the rest of the
    // codebase does: confirming that an administrative surface exists is itself
    // a disclosure to someone who should not know.
    throw new AppError("not_found", "Not found.", {
      internal: `platform admin refused for user ${actor.identity.id}`,
    });
  }

  return Object.assign(actor, { platformAdmin: true as const });
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

/**
 * Confirms the bound identity still matches the address it was bound for.
 *
 * Belt and braces for the migration step: the row is written against a user id
 * resolved out of band, and this is what notices if that id was wrong.
 */
export async function assertAdminEmail(expected: string): Promise<void> {
  const actor = await getActor();
  if (!actor) throw unauthorized();
  if (actor.identity.email.toLowerCase() !== expected.toLowerCase()) {
    throw new AppError("not_found", "Not found.", {
      internal: `platform admin id/email mismatch for ${actor.identity.id}`,
    });
  }
}
