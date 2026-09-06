"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { action } from "@/lib/actions/base";

export async function markNotificationRead(id: string) {
  return action(async (user) => {
    // Scoped by userId rather than by workspace: notifications belong to a
    // person, so this is the correct ownership check.
    await db.notification.updateMany({
      where: { id, userId: user.id },
      data: { readAt: new Date() },
    });
    revalidatePath("/", "layout");
    return { id };
  });
}

export async function markAllNotificationsRead() {
  return action(async (user) => {
    const result = await db.notification.updateMany({
      where: { userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    revalidatePath("/", "layout");
    return { count: result.count };
  });
}
