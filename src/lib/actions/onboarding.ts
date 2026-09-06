"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { action } from "@/lib/actions/base";

export async function completeOnboarding() {
  return action(async (user) => {
    await db.user.update({
      where: { id: user.id },
      data: { onboardedAt: new Date(), lastSeenAt: new Date() },
    });
    revalidatePath("/", "layout");
    return { ok: true };
  });
}
