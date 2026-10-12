import { NextResponse, type NextRequest } from "next/server";

import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readScope } from "@/lib/scope";
import { log } from "@/lib/logger";
import { withTenantContext } from "@/lib/tenant-db";
import { beginConnection } from "@/lib/integrations/connections";
import { providerFor } from "@/lib/integrations/providers";
import { verifierCookieOptions } from "@/lib/integrations/cookies";

/**
 * Starts a connection: builds the authorisation URL and redirects to it.
 *
 * ## Why a route and not a server action
 *
 * The flow has to end with the browser at the provider's consent screen, and
 * it has to set an httpOnly cookie on the way. A server action can do neither
 * cleanly — it returns data to a client component, which would then have to
 * perform the navigation itself and could not be given the cookie in the same
 * response. A GET that redirects is the shape the OAuth flow actually is.
 *
 * ## Why POST rather than GET
 *
 * This is a state-changing step: it mints a verifier and sets a cookie. A GET
 * would be prefetchable by a browser or a link scanner, which would burn the
 * cookie before the person clicked. POST with the form's origin checked by the
 * framework is the conservative choice.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ vendor: string }> },
) {
  const { vendor } = await context.params;
  const form = await request.formData();
  const providerId = String(form.get("provider") ?? "");
  const workspaceId = String(form.get("workspaceId") ?? "");

  const provider = providerFor(providerId);
  const settings = new URL("/settings/integrations", request.nextUrl.origin);

  if (!provider || provider.vendor !== vendor) {
    settings.searchParams.set("connection", "invalid");
    return NextResponse.redirect(settings, { status: 303 });
  }

  const actor = await requireActor();
  const read = await resolveReadScope(await readScope());
  // The workspace comes from the form, so it is checked against the session's
  // own memberships rather than trusted. `beginConnection` puts it in the
  // signed state, and the callback checks it again — a workspace id a browser
  // supplied must never be the thing that decides where a mailbox lands.
  if (!read.workspaceIds.includes(workspaceId)) {
    settings.searchParams.set("connection", "invalid");
    return NextResponse.redirect(settings, { status: 303 });
  }

  try {
    const start = await withTenantContext(
      { workspaceIds: read.workspaceIds, userId: actor.identity.id, restrictedWorkspaceIds: read.restrictedWorkspaceIds },
      () =>
        beginConnection({
          provider,
          workspaceId,
          userId: actor.identity.id,
          origin: request.nextUrl.origin,
        }),
    );

    const response = NextResponse.redirect(start.authorizeUrl, { status: 303 });
    response.cookies.set({
      ...verifierCookieOptions(request.nextUrl.origin),
      value: start.codeVerifier,
    });
    log.info("integration connection started", { provider: provider.id, workspaceId });
    return response;
  } catch (error) {
    log.warn("integration connection could not be started", {
      provider: provider.id,
      reason: error instanceof Error ? error.message : String(error),
    });
    settings.searchParams.set(
      "connection",
      (error as { category?: string }).category === "plan_limit" ? "plan" : "unavailable",
    );
    return NextResponse.redirect(settings, { status: 303 });
  }
}
