import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Tables are the primary way this app shows data — per the design brief, lists
 * and tables beat cards. These are thin styled wrappers rather than a table
 * engine, so each screen keeps control of its own columns and interactions.
 */
export function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  );
}

export function THead({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      className={cn("border-b border-hairline bg-sunken/40 [&_th]:whitespace-nowrap", className)}
      {...props}
    />
  );
}

export function TH({
  className,
  align = "left",
  ...props
}: React.ComponentProps<"th"> & { align?: "left" | "right" | "center" }) {
  return (
    <th
      scope="col"
      className={cn(
        "px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        className,
      )}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody className={cn("divide-y divide-hairline", className)} {...props} />;
}

export function TR({
  className,
  interactive,
  ...props
}: React.ComponentProps<"tr"> & { interactive?: boolean }) {
  return (
    <tr
      className={cn(
        "group transition-colors",
        interactive && "cursor-pointer hover:bg-sunken/60",
        className,
      )}
      {...props}
    />
  );
}

export function TD({
  className,
  align = "left",
  ...props
}: React.ComponentProps<"td"> & { align?: "left" | "right" | "center" }) {
  return (
    <td
      className={cn(
        "px-3 py-2.5 align-middle text-body",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
      {...props}
    />
  );
}

/** Primary cell content: a strong title with optional secondary line. */
export function CellStack({
  title,
  subtitle,
  leading,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  leading?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      {leading}
      <div className="min-w-0">
        <div className="truncate font-medium text-body">{title}</div>
        {subtitle ? <div className="truncate text-xs text-muted">{subtitle}</div> : null}
      </div>
    </div>
  );
}
