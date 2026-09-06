"use server";

import { db } from "@/lib/db";
import {
  audit, guard, recordAction, revalidateRecord, type ActionResult,
} from "@/lib/actions/base";

/**
 * Automations run with the workspace's authority rather than a user's, so who
 * may enable one is an administrative decision. The prototype checked a role
 * string here; the permission is now resolved centrally, and the record's
 * workspace is derived from the record rather than supplied alongside it.
 */
export async function setAutomationEnabled(
  id: string,
  enabled: boolean,
): Promise<ActionResult<{ id: string; enabled: boolean }>> {
  return guard(() =>
    recordAction("automation", id, { permission: "automations:manage", rateLimit: "mutation" },
      async ({ actor, workspaceId, recordId }) => {
        const next = Boolean(enabled);

        await db.automation.updateMany({
          where: { id: recordId, workspaceId },
          data: { enabled: next },
        });

        await audit(actor, {
          workspaceId,
          action: "automation.changed",
          entityType: "automation",
          entityId: recordId,
          summary: `${next ? "Enabled" : "Disabled"} an automation`,
        });

        revalidateRecord(["/automations"]);
        return { id: recordId, enabled: next };
      },
    ),
  );
}
