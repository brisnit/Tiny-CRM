"use server";

import { db } from "@/lib/db";
import { action, guard, type ActionResult, revalidateLayout } from "@/lib/actions/base";

export async function completeOnboarding(): Promise<ActionResult<{ ok: true }>> {
  return guard(() =>
    action(
      async (actor) => {
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
