"use server";

import { db } from "@/lib/db";
import { action, audit, guard, type ActionResult, revalidateLayout } from "@/lib/actions/base";
import { provisionWorkspace } from "@/lib/workspaces/provision";

/**
 * Finishes onboarding, and guarantees the account can actually be used.
 *
 * ---------------------------------------------------------------------------
 * The bug this exists to make impossible
 * ---------------------------------------------------------------------------
 *
 * An external tester reported: *"not working for me when I skipped setup. Now
 * its a blank screen."* They were right, and it was worse than a blank screen.
 *
 * "Skip setup" called this action, which set `onboardedAt` and created nothing
 * else. Two guards then disagreed permanently:
 *
 *   src/app/(app)/layout.tsx    no workspace  -> redirect to /welcome
 *   src/app/(app)/welcome/page  no workspace  -> render onboarding again
 *
 * The layout sends every app route to /welcome while the account has no
 * workspace, and /welcome only steps aside once one exists. Skipping created
 * none, so the two conditions could never both be satisfied: /home, /projects,
 * /contacts, /deals, /tasks and /settings all bounced back to onboarding
 * forever, and the moment of skipping rendered an empty frame while that
 * redirect chain resolved. No console error, no failed request, no exception —
 * which is why it reached a real user.
 *
 * The fix is not to special-case the blank frame. It is to make the state that
 * caused it unreachable: **completing onboarding always leaves the account with
 * at least one workspace.** Skipping setup is then a legitimate choice rather
 * than a trap — it lands on a real, empty home screen, and the workspace can be
 * renamed in settings whenever the user gets around to it.
 *
 * Deliberately idempotent: a second call adds nothing. `finish()` is bound to
 * both "Skip setup" and the final step, and a double-submit must not leave a
 * customer with two workspaces on a plan that allows one.
 */
export async function completeOnboarding(): Promise<ActionResult<{ ok: true }>> {
  return guard(() =>
    action(
      async (actor) => {
        // `actor.memberships` is resolved before the action body runs, and is
        // the same source both redirect guards consult.
        if (actor.memberships.length === 0) {
          const firstName = actor.identity.name.trim().split(/\s+/)[0];
          const name = firstName ? `${firstName}'s workspace` : "My workspace";

          const workspace = await provisionWorkspace(actor.identity.id, { name });

          await audit(actor, {
            workspaceId: workspace.id,
            action: "workspace.created",
            entityType: "workspace",
            entityId: workspace.id,
            summary: `Created workspace ${workspace.name} while completing onboarding`,
          });
        }

        await db.user.update({
          where: { id: actor.identity.id },
          data: { onboardedAt: new Date(), lastSeenAt: new Date() },
        });

        revalidateLayout();
        return { ok: true as const };
      },
      { rateLimit: "mutation" },
    ),
  );
}
