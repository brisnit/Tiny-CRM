import { NextResponse } from "next/server";

import { getCurrentUser, resolveScope } from "@/lib/auth/session";
import { searchEverything } from "@/lib/data/search";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ hits: [] }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") ?? "";
  const scope = searchParams.get("scope");

  const { workspaceIds } = await resolveScope(user.id, scope);
  const hits = await searchEverything(workspaceIds, q);

  return NextResponse.json({ hits: hits.slice(0, 30) });
}
