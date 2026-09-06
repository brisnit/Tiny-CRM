"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { action, guard, type ActionResult } from "@/lib/actions/base";

export async function completeOnboarding(): Promise<ActionResult<{ ok: true }>> {
  return guard(() =>
    action(
      async (actor) => {
        await db.user.update({
          where: { id: actor.identity.id },
          data: { onboardedAt: new Date(), lastSeenAt: new Date() },
        });
        revalidatePath("/", "layout");
        return { ok: true as const };
      },
      { rateLimit: "mutation" },
    ),
  );
}
