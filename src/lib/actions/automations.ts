"use server";

import { db } from "@/lib/db";
import { action, requireWorkspace, revalidateRecord } from "@/lib/actions/base";

export async function setAutomationEnabled(id: string, enabled: boolean) {
  return action(async (user) => {
    const automation = await db.automation.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true },
    });
    await requireWorkspace(user.id, automation.workspaceId, "admin");
    await db.automation.update({ where: { id }, data: { enabled } });
    revalidateRecord(["/automations"]);
    return { id, enabled };
  });
}
