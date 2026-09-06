"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import { action, emptyToNull, logActivity, optionalDate, optionalInt, requireWorkspace, revalidateRecord } from "@/lib/actions/base";
import { ACTIVITY_TYPE } from "@/lib/enums";

const activitySchema = z.object({
  workspaceId: z.string().min(1),
  type: z.enum(ACTIVITY_TYPE.values),
  title: z.string().trim().min(1, "Add a short summary"),
  body: emptyToNull,
  direction: z.enum(["inbound", "outbound", "internal"]).nullish(),
  durationMin: optionalInt,
  occurredAt: optionalDate,
  contactId: emptyToNull,
  companyId: emptyToNull,
  dealId: emptyToNull,
  projectId: emptyToNull,
  opportunityId: emptyToNull,
});

/** "Log a call / meeting / email" straight from any record timeline. */
export async function logTimelineEntry(input: z.input<typeof activitySchema>) {
  return action(async (user) => {
    const data = activitySchema.parse(input);
    await requireWorkspace(user.id, data.workspaceId);

    await logActivity({
      ...data,
      actorId: user.id,
      occurredAt: data.occurredAt ?? new Date(),
    });

    revalidateRecord([
      "/home", "/contacts", "/companies", "/projects", "/deals", "/opportunities",
    ]);
    return { ok: true };
  });
}

export async function deleteActivity(id: string) {
  return action(async (user) => {
    const existing = await db.activity.findUniqueOrThrow({ where: { id }, select: { workspaceId: true } });
    await requireWorkspace(user.id, existing.workspaceId, "manager");
    await db.activity.delete({ where: { id } });
    revalidateRecord(["/home"]);
    return { id };
  });
}
