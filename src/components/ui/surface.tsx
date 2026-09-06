import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The app's one container. Borders separate, not shadows — per the design
 * brief, this is deliberately not a card-heavy interface.
 */
export function Panel({
  className,
  flush,
  ...props
}: React.ComponentProps<"div"> & { flush?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-hairline bg-panel",
        !flush && "overflow-hidden",
        className,
      )}
      {...props}
    />
  );
}

export function PanelHeader({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3 px-4 py-3", className)}>
      <div className="flex min-w-0 items-start gap-2.5">
        {icon ? <span className="mt-0.5 text-faint [&_svg]:size-4">{icon}</span> : null}
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-semibold tracking-[-0.01em] text-body">{title}</h3>
          {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** Small caps section label used above lists and in the sidebar. */
export function SectionLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("text-[11px] font-semibold uppercase tracking-[0.08em] text-faint", className)}
      {...props}
    />
  );
}

export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("skeleton rounded-md", className)} {...props} />;
}
