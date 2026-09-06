import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getCurrentUser, resolveScope } from "@/lib/auth/session";

/**
 * Backs every record picker in the app. Pickers query this rather than
 * receiving a preloaded list, so a workspace with 10,000 contacts costs the
 * same to render a form as one with ten.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ options: [] }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type") ?? "contact";
  const q = (searchParams.get("q") ?? "").trim();
  const workspaceParam = searchParams.get("workspaceId");

  const { workspaceIds } = await resolveScope(user.id, workspaceParam ?? "all");
  if (workspaceIds.length === 0) return NextResponse.json({ options: [] });

  const scope = { workspaceId: { in: workspaceIds } };
  const take = 20;

  switch (type) {
    case "contact": {
      const rows = await db.contact.findMany({
        where: {
          ...scope, archivedAt: null,
          ...(q ? { OR: [{ fullName: { contains: q } }, { email: { contains: q } }] } : {}),
        },
        select: { id: true, fullName: true, jobTitle: true, company: { select: { name: true } } },
        orderBy: q ? { fullName: "asc" } : { lastContactedAt: "desc" },
        take,
      });
      return NextResponse.json({
        options: rows.map((r) => ({
          value: r.id,
          label: r.fullName,
          hint: [r.jobTitle, r.company?.name].filter(Boolean).join(" · ") || undefined,
        })),
      });
    }
    case "company": {
      const rows = await db.company.findMany({
        where: { ...scope, archivedAt: null, ...(q ? { name: { contains: q } } : {}) },
        select: { id: true, name: true, industry: true },
        orderBy: q ? { name: "asc" } : { lastActivityAt: "desc" },
        take,
      });
      return NextResponse.json({
        options: rows.map((r) => ({ value: r.id, label: r.name, hint: r.industry ?? undefined })),
      });
    }
    case "project": {
      const rows = await db.project.findMany({
        where: { ...scope, archivedAt: null, ...(q ? { name: { contains: q } } : {}) },
        select: { id: true, name: true, company: { select: { name: true } } },
        orderBy: { lastActivityAt: "desc" },
        take,
      });
      return NextResponse.json({
        options: rows.map((r) => ({ value: r.id, label: r.name, hint: r.company?.name ?? undefined })),
      });
    }
    case "deal": {
      const rows = await db.deal.findMany({
        where: { ...scope, archivedAt: null, ...(q ? { name: { contains: q } } : {}) },
        select: { id: true, name: true, stage: { select: { name: true } } },
        orderBy: { lastActivityAt: "desc" },
        take,
      });
      return NextResponse.json({
        options: rows.map((r) => ({ value: r.id, label: r.name, hint: r.stage.name })),
      });
    }
    case "opportunity": {
      const rows = await db.opportunity.findMany({
        where: { ...scope, archivedAt: null, ...(q ? { name: { contains: q } } : {}) },
        select: { id: true, name: true, company: { select: { name: true } } },
        orderBy: { deadlineAt: "asc" },
        take,
      });
      return NextResponse.json({
        options: rows.map((r) => ({ value: r.id, label: r.name, hint: r.company?.name ?? undefined })),
      });
    }
    case "tag": {
      const rows = await db.tag.findMany({
        where: { ...scope, ...(q ? { name: { contains: q } } : {}) },
        select: { id: true, name: true, color: true },
        orderBy: { name: "asc" },
        take: 40,
      });
      return NextResponse.json({
        options: rows.map((r) => ({ value: r.name, label: r.name, color: r.color })),
      });
    }
    default:
      return NextResponse.json({ options: [] });
  }
}
