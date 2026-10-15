import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

import { requireActor, resolveReadScope } from "@/lib/auth/access";
import { readScope } from "@/lib/scope";
import { log } from "@/lib/logger";
import { withTenantContext } from "@/lib/tenant-db";
import { dispatchSoon } from "@/lib/events";
import { completeConnection } from "@/lib/integrations/connections";
import { PROVIDERS, providerFor, type ProviderId } from "@/lib/integrations/providers";
import { VERIFIER_COOKIE, clearVerifierCookie } from "@/lib/integrations/cookies";

/**
 * Where the provider sends the person back.
 *
 * One route for both vendors, keyed on `[vendor]`, because the registered
 * redirect URI is per-vendor and the handling is identical.
 *
 * ## Why it redirects rather than rendering
 *
 * A callback URL ends up in browser history, in a referrer, and sometimes in a
 * support ticket. Rendering the outcome here would mean the authorisation code
 * stays in the address bar of a page the customer is looking at. Redirecting to
 * Settings with a short status code in the query leaves nothing sensitive
 * behind, and the back button lands somewhere harmless.
 *
 * ## What it does not do
 *
 * It does not import anything. A completed handshake means **connected**, not
 * **synced** — no message or event exists until the sync worker runs, and the
 * Settings page says so in those words.
 */
export const dynamic = "force-dynamic";

/** Which provider a vendor's callback is completing, from the signed state. */
function providerFromState(raw: string | null): ProviderId | null {
  if (!raw) return null;
  try {
    const payload = raw.split(".")[1];
    if (!payload) return null;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      provider?: string;
    };
    // Untrusted at this point — the signature has not been checked yet. It is
    // used only to pick which config to hand to completeConnection, which
    // verifies the signature and then checks the provider matches.
    return parsed.provider && Object.hasOwn(PROVIDERS, parsed.provider)
      ? (parsed.provider as ProviderId)
      : null;
  } catch {
    return null;
  }
}

function back(request: NextRequest, status: string): NextResponse {
  const url = new URL("/settings/integrations", request.nextUrl.origin);
  url.searchParams.set("connection", status);
  const response = NextResponse.redirect(url);
  clearVerifierCookie(response);
  return response;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ vendor: string }> },
) {
  const { vendor } = await context.params;
  if (vendor !== "microsoft" && vendor !== "google") return back(request, "unknown");

  // The person must still be signed in. Without this the callback would be
  // completable by anyone holding the URL.
  const actor = await requireActor();
  const read = await resolveReadScope(await readScope());

  const params = request.nextUrl.searchParams;

  // The provider reports a refusal here rather than by failing the exchange —
  // this is what a customer clicking "Cancel" on the consent screen produces.
  const providerError = params.get("error");
  if (providerError) {
    log.info("integration consent not granted", {
      vendor,
      // Diagnostic codes only; the description can be long but carries no secret.
      error: providerError,
    });
    return back(request, providerError === "access_denied" ? "declined" : "failed");
  }

  const code = params.get("code");
  const state = params.get("state");
  const providerId = providerFromState(state);
  const provider = providerId ? providerFor(providerId) : null;
  if (!code || !provider || provider.vendor !== vendor) return back(request, "invalid");

  const jar = await cookies();
  const codeVerifier = jar.get(VERIFIER_COOKIE)?.value ?? null;

  try {
    const result = await withTenantContext(
      { workspaceIds: read.workspaceIds, userId: actor.identity.id, restrictedWorkspaceIds: read.restrictedWorkspaceIds },
      () =>
        completeConnection({
          provider,
          code,
          state,
          codeVerifier,
          session: { userId: actor.identity.id, workspaceIds: read.workspaceIds },
          origin: request.nextUrl.origin,
        }),
    );
    log.info("integration connected via callback", {
      provider: provider.id,
      integrationId: result.integrationId,
    });

    // `completeConnection` queued the first page; queueing is not running.
    // Without this the import waits for the next cron tick — up to thirty
    // minutes in production, and forever on a developer machine, where no
    // cron exists. The canary found it that way: connected, zero pages, a
    // pending job and `lastSyncAt` of never.
    //
    // Detached and best effort, as everywhere else: a dispatch that fails, or
    // that the platform freezes after the response, must not fail a
    // connection that has already been made. The cron is the guarantee; this
    // is the immediacy.
    dispatchSoon();
    return back(request, "connected");
  } catch (error) {
    // The reason is logged, never redirected into the browser's address bar.
    log.warn("integration callback refused", {
      provider: provider.id,
      reason: error instanceof Error ? error.message : String(error),
    });
    const code = (error as { providerCode?: string }).providerCode;
    if (code === "scope_declined") return back(request, "incomplete");
    if (code === "tenant_mismatch") return back(request, "wrong-organisation");
    return back(request, "failed");
  }
}
