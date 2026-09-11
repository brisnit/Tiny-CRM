"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { acceptInvitation } from "@/lib/actions/team";

/**
 * The button that joins a workspace.
 *
 * A deliberate click rather than an automatic acceptance on page load: an
 * invitation link can be prefetched, scanned by a mail client, or opened by
 * accident, and none of those should silently add someone to a company's CRM.
 *
 * On success it leaves with a full page load rather than a router push. The
 * membership that was just created changes what every layout above this point
 * is allowed to render, and a client-side navigation would carry the old,
 * memberless shell into the new state.
 */
export function InviteAccept({
  token,
  workspaceName,
}: {
  token: string;
  workspaceName: string;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function join() {
    setPending(true);
    setError(null);
    const result = await acceptInvitation(token);
    if (!result.ok) {
      setError(result.error);
      setPending(false);
      return;
    }
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/home");
  }

  return (
    <div className="space-y-3">
      {error ? (
        <p
          role="alert"
          className="rounded-lg bg-rose-50 px-3.5 py-2.5 text-[13px] text-rose-800 dark:bg-rose-950/50 dark:text-rose-200"
        >
          {error}
        </p>
      ) : null}
      <Button
        type="button"
        variant="brand"
        size="lg"
        className="w-full"
        loading={pending}
        onClick={join}
      >
        Join {workspaceName}
      </Button>
    </div>
  );
}
