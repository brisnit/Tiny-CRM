import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getActor, resolveReadScope } from "@/lib/auth/access";
import { can } from "@/lib/auth/permissions";
import { toAppError } from "@/lib/errors";
import { log, newRequestId, runWithContext } from "@/lib/logger";
import { enforceRateLimit } from "@/lib/rate-limit";
import { zScope } from "@/lib/validation/common";
import { LIMITS } from "@/lib/validation/limits";
import { scopedRead } from "@/lib/data/scoped";

/**
 * Record pickers.
 *
 * Every query filters on the workspace ids resolved from the session, so a
 * picker cannot be coaxed into listing another tenant's records — which would
 * be a quiet but complete disclosure of names, emails and deal titles.
 */
export const dynamic = "force-dynamic";

const paramsSchema = z.object({
  type: z.enum(["contact", "company", "project", "deal", "opportunity", "tag"]).catch("contact"),
  q: z.string().max(LIMITS.searchQuery.max).catch(""),
  workspaceId: z.string().max(64).nullish(),
});

export async function GET(request: Request) {
  const requestId = newRequestId();

  return runWithContext({ requestId, route: "api.options" }, async () => {
    try {
      const actor = await getActor();
      if (!actor) return NextResponse.json({ options: [], requestId }, { status: 401 });

      await enforceRateLimit("options", { user: actor.identity.id });

      const { searchParams } = new URL(request.url);
      const params = paramsSchema.parse({
        type: searchParams.get("type"),
        q: searchParams.get("q"),
        workspaceId: searchParams.get("workspaceId"),
      });

      const scope = zScope.parse(params.workspaceId ?? "all");
      const read = await resolveReadScope(scope);

      // This endpoint feeds every record picker in the product, and until now it
      // asked only whether you were signed in. RLS decides which rows come
      // back; the permission decides whether you may ask at all. Narrowed per
      // workspace, so someone who is a viewer in one and a member in another
      // gets the right answer in each.
      const readable = read.workspaceIds.filter((id) => {
        const membership = actor.memberships.find((m) => m.id === id);
        return membership ? can(membership.role, "record:view") : false;
      });
      if (readable.length === 0) return NextResponse.json({ options: [], requestId });
      const scoped = { ...read, workspaceIds: readable };

      const q = params.q.trim();
      const where = { workspaceId: { in: readable } };
      const take = 20;

      const respond = (options: unknown[]) =>
        NextResponse.json(
          { options, requestId },
          { headers: { "x-request-id": requestId, "cache-control": "no-store" } },
        );

      // Every branch below reads a workspace-scoped model, so the whole switch
      // runs in the scope resolveReadScope returned. That set is derived from
      // the actor's memberships; the ?workspaceId parameter can only narrow it.
      return scopedRead(scoped, async () => {
      switch (params.type) {
        case "contact": {
          const rows = await db.contact.findMany({
            where: {
              ...where,
              archivedAt: null,
              ...(q ? { OR: [{ fullName: { contains: q } }, { email: { contains: q } }] } : {}),
            },
            select: { id: true, fullName: true, jobTitle: true, company: { select: { name: true } } },
            orderBy: q ? { fullName: "asc" } : { lastContactedAt: "desc" },
            take,
          });
          return respond(
            rows.map((r) => ({
              value: r.id,
              label: r.fullName,
              hint: [r.jobTitle, r.company?.name].filter(Boolean).join(" · ") || undefined,
            })),
          );
        }
        case "company": {
          const rows = await db.company.findMany({
            where: { ...where, archivedAt: null, ...(q ? { name: { contains: q } } : {}) },
            select: { id: true, name: true, industry: true },
            orderBy: q ? { name: "asc" } : { lastActivityAt: "desc" },
            take,
          });
          return respond(rows.map((r) => ({ value: r.id, label: r.name, hint: r.industry ?? undefined })));
        }
        case "project": {
          const rows = await db.project.findMany({
            where: { ...where, archivedAt: null, ...(q ? { name: { contains: q } } : {}) },
            select: { id: true, name: true, company: { select: { name: true } } },
            orderBy: { lastActivityAt: "desc" },
            take,
          });
          return respond(
            rows.map((r) => ({ value: r.id, label: r.name, hint: r.company?.name ?? undefined })),
          );
        }
        case "deal": {
          const rows = await db.deal.findMany({
            where: { ...where, archivedAt: null, ...(q ? { name: { contains: q } } : {}) },
            select: { id: true, name: true, stage: { select: { name: true } } },
            orderBy: { lastActivityAt: "desc" },
            take,
          });
          return respond(rows.map((r) => ({ value: r.id, label: r.name, hint: r.stage.name })));
        }
        case "opportunity": {
          const rows = await db.opportunity.findMany({
            where: { ...where, archivedAt: null, ...(q ? { name: { contains: q } } : {}) },
            select: { id: true, name: true, company: { select: { name: true } } },
            orderBy: { deadlineAt: "asc" },
            take,
          });
          return respond(
            rows.map((r) => ({ value: r.id, label: r.name, hint: r.company?.name ?? undefined })),
          );
        }
        case "tag": {
          const rows = await db.tag.findMany({
            where: { ...where, ...(q ? { name: { contains: q } } : {}) },
            select: { id: true, name: true, color: true },
            orderBy: { name: "asc" },
            take: 40,
          });
          return respond(rows.map((r) => ({ value: r.name, label: r.name, color: r.color })));
        }
      }
      return respond([]);
      });
    } catch (raw) {
      const error = toAppError(raw);
      if (error.category === "internal") {
        log.error("options lookup failed", { error: String(error.internal) });
      }
      return NextResponse.json(
        { options: [], error: error.message, requestId },
        { status: error.status, headers: { "x-request-id": requestId } },
      );
    }
  });
}
