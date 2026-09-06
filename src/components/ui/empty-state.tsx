import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Empty states carry a line of product philosophy rather than an apology. The
 * headline states why the thing matters; the action gets you out of the empty
 * state in one click.
 */
export function EmptyState({
  icon,
  eyebrow,
  title,
  description,
  action,
  secondary,
  className,
  compact,
}: {
  icon?: React.ReactNode;
  eyebrow?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: { label: string; href?: string; onClick?: () => void; icon?: React.ReactNode };
  secondary?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 px-6 py-10" : "gap-3 px-6 py-16",
        className,
      )}
    >
      {icon ? (
        <div className="mb-1 flex size-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100 dark:bg-brand-950 dark:text-brand-400 dark:ring-brand-900 [&_svg]:size-5">
          {icon}
        </div>
      ) : null}
      {eyebrow ? (
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{eyebrow}</p>
      ) : null}
      <h3 className={cn("font-semibold tracking-[-0.015em] text-body", compact ? "text-sm" : "text-[15px]")}>
        {title}
      </h3>
      {description ? (
        <p className="max-w-sm text-pretty text-[13px] leading-relaxed text-muted">{description}</p>
      ) : null}
      {action ? (
        <div className="mt-2">
          {action.href ? (
            <Button asChild size="sm" variant="brand">
              <Link href={action.href as never}>
                {action.icon}
                {action.label}
              </Link>
            </Button>
          ) : (
            <Button size="sm" variant="brand" onClick={action.onClick}>
              {action.icon}
              {action.label}
            </Button>
          )}
        </div>
      ) : null}
      {secondary ? <div className="mt-1">{secondary}</div> : null}
    </div>
  );
}
