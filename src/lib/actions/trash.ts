"use server";

import { z } from "zod";

import {
  audit, guard, recordAction, revalidateRecord, type ActionResult,
} from "@/lib/actions/base";
import { db } from "@/lib/db";
import { TRASHABLE, type TrashableType } from "@/lib/data/trash";
import { zId } from "@/lib/validation/common";

/**
 * Restoring from trash.
 *
 * One action rather than six, because the screen is one list. The record type is
 * validated against a fixed set and used to pick a Prisma model — never
 * interpolated into a query — and `recordAction` still resolves the workspace
 * from the record itself, so a type/id mismatch or a foreign id fails the same
 * way it would anywhere else.
 */

const MODEL: Record<TrashableType, "contact" | "company" | "deal" | "project" | "opportunity" | "note"> = {
  contact: "contact",
  company: "company",
  deal: "deal",
  project: "project",
  opportunity: "opportunity",
  note: "note",
};

const PATH: Record<TrashableType, string> = {
  contact: "/contacts",
  company: "/companies",
  deal: "/deals",
  project: "/projects",
  opportunity: "/opportunities",
  note: "/notes",
};

export async function restoreFromTrash(
  type: string,
  id: string,
): Promise<ActionResult<{ id: string; type: TrashableType }>> {
  return guard(async () => {
    const kind = z.enum(TRASHABLE).parse(type);
    const model = MODEL[kind];

    return recordAction(model, zId.parse(id), {
      permission: "record:archive",
      rateLimit: "mutation",
    }, async ({ actor, workspaceId, recordId }) => {
      // A model chosen from a fixed map, never a string from the request.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (db as any)[model].updateMany({
        where: { id: recordId, workspaceId, archivedAt: { not: null } },
        data: { archivedAt: null, version: { increment: 1 } },
      });

      if (result.count > 0) {
        await audit(actor, {
          workspaceId,
          action: "record.restored",
          entityType: kind,
          entityId: recordId,
          summary: `Restored a ${kind} from trash`,
        });
      }

      revalidateRecord([PATH[kind], "/settings/data"]);
      return { id: recordId, type: kind };
    });
  });
}
