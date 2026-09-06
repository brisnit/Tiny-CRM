"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { action, guard, type ActionResult } from "@/lib/actions/base";
import { zId } from "@/lib/validation/common";

/**
 * Notifications belong to a person, not to a workspace, so ownership — not
 * membership — is the correct check. Both writes filter on `userId` in the
 * WHERE clause, so an id from someone else's inbox matches nothing.
 */
export async function markNotificationRead(id: string): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    action(
      async (actor) => {
        const notificationId = zId.parse(id);
        await db.notification.updateMany({
          where: { id: notificationId, userId: actor.identity.id },
          data: { readAt: new Date() },
        });
        revalidatePath("/", "layout");
        return { id: notificationId };
      },
      { rateLimit: "mutation" },
    ),
  );
}

export async function markAllNotificationsRead(): Promise<ActionResult<{ count: number }>> {
  return guard(() =>
    action(
      async (actor) => {
        const result = await db.notification.updateMany({
          where: { userId: actor.identity.id, readAt: null },
          data: { readAt: new Date() },
        });
        revalidatePath("/", "layout");
        return { count: result.count };
      },
      { rateLimit: "mutation" },
    ),
  );
}
