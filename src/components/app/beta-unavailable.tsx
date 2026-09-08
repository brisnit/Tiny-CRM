import Link from "next/link";
import type { LucideIcon } from "lucide-react";

import { PageHeader, PageShell } from "@/components/app/page-header";
import { Panel } from "@/components/ui/surface";
import { Button } from "@/components/ui/button";

/**
 * A route that exists but is not part of this beta.
 *
 * The alternative was worse in both directions. Leaving these screens in the
 * navigation promised a feature the product does not have: the automations page
 * explained what a rule is and offered no way to make one, and the files page
 * invited people to attach proposals with no upload control. Deleting the
 * routes would have made a bookmarked URL a 404, which reads like breakage
 * rather than a decision.
 *
 * So the route answers honestly and says what it is waiting for. Nothing
 * underneath is removed — the automation engine still runs from the outbox and
 * the storage layer still exists behind `STORAGE_DRIVER`.
 */
export function BetaUnavailable({
  title,
  icon: Icon,
  what,
  why,
}: {
  title: string;
  icon: LucideIcon;
  what: string;
  why: string;
}) {
  return (
    <PageShell>
      <PageHeader title={title} description={what} />
      <Panel className="p-10 text-center">
        <div className="mx-auto flex size-11 items-center justify-center rounded-full border border-hairline bg-sunken">
          <Icon className="size-5 text-muted" />
        </div>
        <h2 className="mt-4 text-[15px] font-semibold text-body">Not part of this beta</h2>
        <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted">{why}</p>
        <div className="mt-5 flex justify-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/home">Back to home</Link>
          </Button>
        </div>
      </Panel>
    </PageShell>
  );
}
