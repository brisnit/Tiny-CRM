import * as React from "react";
import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * A single number with its label and, where it helps, one line of context.
 * Deliberately borderless inside a shared panel — a grid of bordered cards is
 * exactly the clutter this product is trying to avoid.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = "default",
  href,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "default" | "brand" | "warn" | "danger";
  href?: string;
  icon?: React.ReactNode;
}) {
  const tones = {
    default: "text-body",
    brand: "text-brand-600 dark:text-brand-400",
    warn: "text-amber-600 dark:text-amber-400",
    danger: "text-rose-600 dark:text-rose-400",
  } as const;

  const inner = (
    <div className="flex h-full min-w-0 flex-col justify-between gap-2 p-4">
      <div className="flex items-center gap-1.5">
        {icon ? <span className="text-faint [&_svg]:size-3.5">{icon}</span> : null}
        <span className="truncate text-[11px] font-semibold uppercase tracking-[0.07em] text-faint">{label}</span>
      </div>
      <div>
        <div className={cn("text-2xl font-semibold leading-none tracking-[-0.02em] tabular", tones[tone])}>
          {value}
        </div>
        {hint ? <div className="mt-1.5 truncate text-[12px] text-muted">{hint}</div> : null}
      </div>
    </div>
  );

  if (href) {
    return (
      <Link href={href as never} className="block h-full transition-colors hover:bg-sunken/60">
        {inner}
      </Link>
    );
  }
  return inner;
}

/** Row of stat tiles separated by hairlines rather than card gutters. */
export function StatRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 divide-x divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-panel sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0",
        className,
      )}
    >
      {children}
    </div>
  );
}
