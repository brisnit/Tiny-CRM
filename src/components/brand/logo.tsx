import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The mark, redrawn as SVG from the brand sheet so it stays crisp at every
 * size and can adapt to dark mode (the PNG cannot). Three figures: a larger
 * centre in brand green, two lighter supporting figures.
 */
export function LogoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 64 44"
      className={cn("size-6", className)}
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {/* Left figure */}
      <circle cx="12.5" cy="13.5" r="7.5" fill="var(--color-brand-400)" />
      <path
        d="M0 42v-8.5C0 27.7 5.6 23 12.5 23S25 27.7 25 33.5V42a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2Z"
        fill="var(--color-brand-400)"
      />
      {/* Right figure */}
      <circle cx="51.5" cy="13.5" r="7.5" fill="var(--color-brand-400)" />
      <path
        d="M39 42v-8.5C39 27.7 44.6 23 51.5 23S64 27.7 64 33.5V42a2 2 0 0 1-2 2H41a2 2 0 0 1-2-2Z"
        fill="var(--color-brand-400)"
      />
      {/* Centre figure, drawn last so it sits in front */}
      <circle cx="32" cy="10.5" r="10.5" fill="var(--color-brand-500)" />
      <path
        d="M14 42v-8C14 26.3 22.1 20 32 20s18 6.3 18 14v8a2 2 0 0 1-2 2H16a2 2 0 0 1-2-2Z"
        fill="var(--color-brand-500)"
      />
    </svg>
  );
}

export function Logo({
  className,
  markClassName,
  showWordmark = true,
}: {
  className?: string;
  markClassName?: string;
  showWordmark?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark className={cn("size-7", markClassName)} title="Tiny CRM" />
      {showWordmark ? (
        <span className="text-[17px] font-extrabold leading-none tracking-[-0.03em]">
          <span className="text-brand-800 dark:text-white">tiny</span>
          <span className="text-brand-400"> crm</span>
        </span>
      ) : null}
    </span>
  );
}

/** Stacked lockup for the marketing hero and auth screens. */
export function LogoLockup({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex flex-col items-center gap-2", className)}>
      <LogoMark className="size-12" title="Tiny CRM" />
      <span className="text-2xl font-extrabold leading-none tracking-[-0.03em]">
        <span className="text-brand-800 dark:text-white">tiny</span>
        <span className="text-brand-400"> crm</span>
      </span>
    </span>
  );
}
