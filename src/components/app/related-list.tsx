import * as React from "react";
import Link from "next/link";

import { Panel, PanelHeader } from "@/components/ui/surface";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

/**
 * The "what else is connected to this" panel. Every record page is mostly
 * composed of these, which is how the relational model becomes visible.
 */
export function RelatedList({
  title,
  description,
  icon,
  action,
  emptyTitle,
  emptyDescription,
  items,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  emptyTitle: string;
  emptyDescription?: string;
  items: {
    id: string;
    href?: string;
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    trailing?: React.ReactNode;
    leading?: React.ReactNode;
  }[];
  className?: string;
}) {
  return (
    <Panel className={className}>
      <PanelHeader title={title} description={description} icon={icon} action={action} />
      {items.length === 0 ? (
        <div className="border-t border-hairline">
          <EmptyState compact title={emptyTitle} description={emptyDescription} />
        </div>
      ) : (
        <ul className="divide-y divide-hairline border-t border-hairline">
          {items.map((item) => {
            const inner = (
              <div className="flex items-center gap-3 px-4 py-2.5">
                {item.leading}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-body">{item.title}</div>
                  {item.subtitle ? (
                    <div className="truncate text-[11.5px] text-muted">{item.subtitle}</div>
                  ) : null}
                </div>
                {item.trailing ? <div className="shrink-0">{item.trailing}</div> : null}
              </div>
            );
            return (
              <li key={item.id}>
                {item.href ? (
                  <Link
                    href={item.href as never}
                    className={cn("block transition-colors hover:bg-sunken/60")}
                  >
                    {inner}
                  </Link>
                ) : (
                  inner
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
