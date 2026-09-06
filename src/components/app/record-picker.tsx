"use client";

import * as React from "react";
import { Check, ChevronsUpDown, Loader2, Search, X } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useSyncedState } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export type PickerOption = { value: string; label: string; hint?: string; color?: string };

/**
 * Async single-select over CRM records. Options are fetched from /api/options as
 * the user types, so this stays fast regardless of how much data a workspace
 * holds.
 */
export function RecordPicker({
  type,
  value,
  onChange,
  workspaceId,
  placeholder = "Search…",
  emptyLabel = "None",
  allowClear = true,
  initialLabel,
  className,
  size = "md",
}: {
  type: "contact" | "company" | "project" | "deal" | "opportunity";
  value: string | null;
  onChange: (value: string | null, option?: PickerOption) => void;
  workspaceId?: string | null;
  placeholder?: string;
  emptyLabel?: string;
  allowClear?: boolean;
  initialLabel?: string | null;
  className?: string;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [options, setOptions] = React.useState<PickerOption[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [label, setLabel] = useSyncedState<string | null>(initialLabel ?? null);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (!cancelled) setLoading(true);
      try {
        const params = new URLSearchParams({ type, q: query });
        if (workspaceId) params.set("workspaceId", workspaceId);
        const res = await fetch(`/api/options?${params}`);
        const json = (await res.json()) as { options: PickerOption[] };
        if (!cancelled) setOptions(json.options ?? []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, query ? 180 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, type, workspaceId]);

  function choose(option: PickerOption) {
    setLabel(option.label);
    onChange(option.value, option);
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg border border-hairline-strong bg-panel px-3 text-sm transition-colors",
          "hover:border-hairline-strong focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20",
          size === "sm" ? "h-8 text-[13px]" : "h-9",
          className,
        )}
      >
        <span className={cn("truncate", value && label ? "text-body" : "text-faint")}>
          {value && label ? label : emptyLabel}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {value && allowClear ? (
            <span
              role="button"
              tabIndex={-1}
              aria-label="Clear"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setLabel(null);
                onChange(null);
              }}
              className="rounded p-0.5 text-faint hover:bg-sunken hover:text-body"
            >
              <X className="size-3.5" />
            </span>
          ) : null}
          <ChevronsUpDown className="size-3.5 text-faint" />
        </span>
      </PopoverTrigger>

      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0" align="start">
        <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
          <Search className="size-3.5 shrink-0 text-faint" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            className="w-full bg-transparent text-[13px] text-body outline-none placeholder:text-faint"
          />
          {loading ? <Loader2 className="size-3.5 shrink-0 animate-spin text-faint" /> : null}
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {options.length === 0 && !loading ? (
            <p className="px-3 py-6 text-center text-[13px] text-faint">
              {query ? "Nothing matched." : "Start typing to search."}
            </p>
          ) : null}
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => choose(option)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-body transition-colors hover:bg-sunken"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{option.label}</span>
                {option.hint ? <span className="block truncate text-[11px] text-faint">{option.hint}</span> : null}
              </span>
              {value === option.value ? <Check className="size-3.5 shrink-0 text-brand-500" /> : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
