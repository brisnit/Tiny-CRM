import "server-only";

import { db } from "@/lib/db";
import { parseJson } from "@/lib/json";

/**
 * Lightweight workflow engine.
 *
 * Automations are stored as trigger + conditions + actions (JSON), and run
 * inline on the write that caused them. That keeps the whole feature free of a
 * queue or scheduler for now, while the shape (`runAutomations`) is the same one
 * a background worker would call — so moving deadline- and inactivity-based
 * triggers onto a cron is a change of caller, not of engine.
 */

export type AutomationCondition = { field: string; op: string; value: unknown };

export type AutomationAction =
  | { type: "create_task"; title: string; dueInDays?: number; priority?: string }
  | { type: "create_checklist"; items: string[]; dueInDays?: number }
  | { type: "notify_owner"; message: string }
  | { type: "set_health"; health: string }
  | { type: "add_tag"; tag: string };

export type RunContext = Record<string, string | number | boolean | null>;

export async function runAutomations(input: {
  workspaceId: string;
  userId: string;
  trigger: string;
  entityType: "deal" | "project" | "contact" | "opportunity" | "task";
  entityId: string;
  context: RunContext;
}) {
  const automations = await db.automation.findMany({
    where: { workspaceId: input.workspaceId, enabled: true, trigger: input.trigger },
  });
  if (automations.length === 0) return;

  for (const automation of automations) {
    const conditions = parseJson<AutomationCondition[]>(automation.conditions, []);
    if (!conditionsMatch(conditions, input.context)) {
      await db.automationRun.create({
        data: {
          automationId: automation.id,
          entityType: input.entityType,
          entityId: input.entityId,
          status: "skipped",
          message: "Conditions not met",
        },
      });
      continue;
    }

    const actions = parseJson<AutomationAction[]>(automation.actions, []);
    try {
      for (const act of actions) await applyAction(act, input);
      await db.automation.update({
        where: { id: automation.id },
        data: { lastRunAt: new Date(), runCount: { increment: 1 } },
      });
      await db.automationRun.create({
        data: {
          automationId: automation.id,
          entityType: input.entityType,
          entityId: input.entityId,
          status: "success",
          message: actions.map((a) => a.type).join(", "),
        },
      });
    } catch (error) {
      await db.automationRun.create({
        data: {
          automationId: automation.id,
          entityType: input.entityType,
          entityId: input.entityId,
          status: "error",
          message: error instanceof Error ? error.message : "Unknown error",
        },
      });
    }
  }
}

function conditionsMatch(conditions: AutomationCondition[], context: RunContext) {
  if (conditions.length === 0) return true;
  return conditions.every((c) => {
    const actual = context[normaliseField(c.field)];
    switch (c.op) {
      case "equals": return String(actual) === String(c.value);
      case "not_equals": return String(actual) !== String(c.value);
      case "contains": return String(actual ?? "").toLowerCase().includes(String(c.value).toLowerCase());
      case "gte": return Number(actual) >= Number(c.value);
      case "lte": return Number(actual) <= Number(c.value);
      case "in": return Array.isArray(c.value) && c.value.map(String).includes(String(actual));
      default: return false;
    }
  });
}

/** Accepts both "stage.name" (stored form) and "stageName" (context form). */
function normaliseField(field: string) {
  return field.replace(/\.(\w)/g, (_, c: string) => c.toUpperCase());
}

async function applyAction(
  act: AutomationAction,
  input: { workspaceId: string; userId: string; entityType: string; entityId: string; context: RunContext },
) {
  const link = relationField(input.entityType, input.entityId);

  switch (act.type) {
    case "create_task": {
      await db.task.create({
        data: {
          workspaceId: input.workspaceId,
          title: act.title,
          ownerId: input.userId,
          priority: act.priority ?? "medium",
          dueAt: act.dueInDays !== undefined ? addDays(act.dueInDays) : null,
          description: "Created automatically by an automation.",
          ...link,
        },
      });
      break;
    }
    case "create_checklist": {
      for (const [i, title] of act.items.entries()) {
        await db.task.create({
          data: {
            workspaceId: input.workspaceId,
            title,
            ownerId: input.userId,
            sortOrder: i,
            dueAt: act.dueInDays !== undefined ? addDays(act.dueInDays) : null,
            description: "Part of an automated checklist.",
            ...link,
          },
        });
      }
      break;
    }
    case "notify_owner": {
      await db.notification.create({
        data: {
          userId: input.userId,
          workspaceId: input.workspaceId,
          type: "ai_recommendation",
          title: act.message,
          entityType: input.entityType,
          entityId: input.entityId,
        },
      });
      break;
    }
    case "set_health": {
      if (input.entityType === "project") {
        await db.project.update({ where: { id: input.entityId }, data: { health: act.health } });
      }
      break;
    }
    case "add_tag": {
      const tag = await db.tag.upsert({
        where: { workspaceId_name: { workspaceId: input.workspaceId, name: act.tag } },
        create: { workspaceId: input.workspaceId, name: act.tag },
        update: {},
      });
      await db.tagLink.upsert({
        where: {
          tagId_entityType_entityId: {
            tagId: tag.id, entityType: input.entityType, entityId: input.entityId,
          },
        },
        create: {
          workspaceId: input.workspaceId, tagId: tag.id,
          entityType: input.entityType, entityId: input.entityId,
        },
        update: {},
      });
      break;
    }
  }
}

function relationField(entityType: string, entityId: string) {
  switch (entityType) {
    case "deal": return { dealId: entityId };
    case "project": return { projectId: entityId };
    case "contact": return { contactId: entityId };
    case "opportunity": return { opportunityId: entityId };
    default: return {};
  }
}

function addDays(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(17, 0, 0, 0);
  return d;
}
