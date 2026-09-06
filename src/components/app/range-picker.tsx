"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { cn } from "@/lib/utils";

const RANGES = [
  { value: "30", label: "30d" },
  { value: "90", label: "90d" },
  { value: "180", label: "6m" },
  { value: "365", label: "1y" },
];

/** Time-range control. One row, above the charts, state in the URL. */
export function RangePicker() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const active = params.get("range") ?? "90";

  return (
    <div className="inline-flex items-center rounded-lg border border-hairline bg-panel p-0.5">
      {RANGES.map((range) => (
        <button
          key={range.value}
          onClick={() => {
            const next = new URLSearchParams(params.toString());
            next.set("range", range.value);
            router.replace(`${pathname}?${next.toString()}` as never, { scroll: false });
          }}
          className={cn(
            "rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors",
            active === range.value ? "bg-sunken text-body" : "text-muted hover:text-body",
          )}
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}
