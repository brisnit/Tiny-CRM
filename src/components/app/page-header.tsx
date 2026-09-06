import * as React from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { cn } from "@/lib/utils";

/** The standard page frame: generous margins, one clear title, actions right. */
export function PageShell({
  className,
  wide,
  ...props
}: React.ComponentProps<"div"> & { wide?: boolean }) {
  return (
    <div
      className={cn("mx-auto w-full px-4 py-6 sm:px-6 lg:px-8", wide ? "max-w-[1600px]" : "max-w-7xl", className)}
      {...props}
    />
  );
}

export function PageHeader({
  title,
  description,
  eyebrow,
  backHref,
  backLabel,
  actions,
  meta,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  backHref?: string;
  backLabel?: string;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-6", className)}>
      {backHref ? (
        <Link
          href={backHref as never}
          className="mb-2 inline-flex items-center gap-1 text-[12px] font-medium text-muted transition-colors hover:text-body"
        >
          <ChevronLeft className="size-3.5" />
          {backLabel ?? "Back"}
        </Link>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {eyebrow ? (
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{eyebrow}</div>
          ) : null}
          <h1 className="text-pretty text-[22px] font-semibold leading-tight tracking-[-0.02em] text-body sm:text-2xl">
            {title}
          </h1>
          {description ? (
            <p className="mt-1.5 max-w-2xl text-pretty text-[13px] leading-relaxed text-muted">{description}</p>
          ) : null}
          {meta ? <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">{meta}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/** A labelled fact in a record header — quiet label, strong value. */
export function MetaItem({
  label,
  children,
  icon,
}: {
  label: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5 text-[12px]">
      {icon ? <span className="text-faint [&_svg]:size-3.5">{icon}</span> : null}
      <span className="text-faint">{label}</span>
      <span className="font-medium text-body">{children}</span>
    </span>
  );
}
