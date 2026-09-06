import * as React from "react";
import { cn } from "@/lib/utils";

export function Badge({
  className,
  tone,
  dot,
  children,
  ...props
}: React.ComponentProps<"span"> & { tone?: string; dot?: string }) {
  return (
    <span
      data-slot="badge"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-5 ring-1 ring-inset whitespace-nowrap",
        tone ?? "bg-sunken text-muted ring-hairline",
        className,
      )}
      {...props}
    >
      {dot ? (
        <span className="size-1.5 shrink-0 rounded-full" style={{ background: dot }} aria-hidden />
      ) : null}
      {children}
    </span>
  );
}

/** A coloured dot + label, for statuses where a full badge is too loud. */
export function DotLabel({
  color,
  children,
  className,
}: {
  color: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm text-body", className)}>
      <span className="size-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
      {children}
    </span>
  );
}
