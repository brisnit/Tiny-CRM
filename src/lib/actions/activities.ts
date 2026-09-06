"use server";

import { z } from "zod";

import { db } from "@/lib/db";
import {
  audit, guard, logActivity, readWorkspaceId, recordAction, revalidateRecord,
  workspaceAction, type ActionResult,
} from "@/lib/actions/base";
import { assertRelations } from "@/lib/auth/access";
import { ACTIVITY_TYPE } from "@/lib/enums";
import { LIMITS } from "@/lib/validation/limits";
import {
  zId, zOptionalDate, zOptionalId, zOptionalInt, zOptionalText, zShortText,
} from "@/lib/validation/common";

const activitySchema = z.object({
  workspaceId: zId,
  type: z.enum(ACTIVITY_TYPE.values),
  title: zShortText.min(1, "Add a short summary"),
  body: zOptionalText(LIMITS.longText),
  direction: z.enum(["inbound", "outbound", "internal"]).nullish(),
  durationMin: zOptionalInt(0, 24 * 60),
  occurredAt: zOptionalDate,
  contactId: zOptionalId,
  companyId: zOptionalId,
  dealId: zOptionalId,
  projectId: zOptionalId,
  opportunityId: zOptionalId,
});

/** "Log a call / meeting / email" straight from any record timeline. */
export async function logTimelineEntry(
  input: z.input<typeof activitySchema>,
): Promise<ActionResult<{ ok: true }>> {
  return guard(() =>
    workspaceAction(
      { workspaceId: readWorkspaceId(input), permission: "record:create", rateLimit: "mutation" },
      async (actor) => {
        const data = activitySchema.parse(input);
        const workspaceId = actor.workspaceId;

        // An activity is the one record that links to everything, so it is also
        // the easiest place to smuggle a foreign id in and have it rendered back
        // on the other tenant's timeline.
        await assertRelations(workspaceId, {
          contactId: data.contactId ?? null,
          companyId: data.companyId ?? null,
          dealId: data.dealId ?? null,
          projectId: data.projectId ?? null,
          opportunityId: data.opportunityId ?? null,
        });

        await logActivity({
          workspaceId,
          actorId: actor.identity.id,
          type: data.type,
          title: data.title,
          body: data.body ?? null,
          direction: data.direction ?? null,
          durationMin: data.durationMin ?? null,
          occurredAt: data.occurredAt ?? new Date(),
          contactId: data.contactId ?? null,
          companyId: data.companyId ?? null,
          dealId: data.dealId ?? null,
          projectId: data.projectId ?? null,
          opportunityId: data.opportunityId ?? null,
        });

        revalidateRecord([
          "/home", "/contacts", "/companies", "/projects", "/deals", "/opportunities",
        ]);
        return { ok: true as const };
      },
    ),
  );
}

/**
 * Removing a timeline entry rewrites history, so it needs `record:delete` and is
 * itself audited — the audit log is the record that cannot be edited away.
 */
export async function deleteActivity(id: string): Promise<ActionResult<{ id: string }>> {
  return guard(() =>
    recordAction("activity", id, { permission: "record:delete", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const activity = await db.activity.findFirstOrThrow({
          where: { id: recordId, workspaceId },
          select: { title: true, type: true, occurredAt: true },
        });

        await db.activity.delete({ where: { id: recordId } });

        await audit(actor, {
          workspaceId,
          action: "record.deleted",
          entityType: "activity",
          entityId: recordId,
          summary: `Deleted timeline entry: ${activity.title}`,
          metadata: { type: activity.type, occurredAt: activity.occurredAt },
        });

        revalidateRecord(["/home"]);
        return { id: recordId };
      },
    ),
  );
}
