import * as React from "react";
import { cn, colorForKey, initials } from "@/lib/utils";

const sizes = {
  xs: "size-5 text-[9px]",
  sm: "size-6 text-[10px]",
  md: "size-8 text-[11px]",
  lg: "size-10 text-sm",
  xl: "size-14 text-lg",
} as const;

export function Avatar({
  name,
  src,
  size = "md",
  square,
  className,
}: {
  name: string;
  src?: string | null;
  size?: keyof typeof sizes;
  square?: boolean;
  className?: string;
}) {
  const tint = colorForKey(name || "?");
  return (
    <span
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center overflow-hidden font-semibold text-white ring-1 ring-black/5",
        square ? "rounded-lg" : "rounded-full",
        sizes[size],
        className,
      )}
      style={src ? undefined : { background: tint }}
      title={name}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="size-full object-cover" />
      ) : (
        initials(name)
      )}
    </span>
  );
}

/** Overlapping avatars for "who is on this" rows. */
export function AvatarStack({
  people,
  max = 4,
  size = "sm",
}: {
  people: { name: string; src?: string | null }[];
  max?: number;
  size?: keyof typeof sizes;
}) {
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <div className="flex items-center -space-x-1.5">
      {shown.map((p, i) => (
        <Avatar key={`${p.name}-${i}`} name={p.name} src={p.src} size={size} className="ring-2 ring-panel" />
      ))}
      {extra > 0 ? (
        <span
          className={cn(
            "inline-flex items-center justify-center rounded-full bg-sunken font-semibold text-muted ring-2 ring-panel",
            sizes[size],
          )}
        >
          +{extra}
        </span>
      ) : null}
    </div>
  );
}
