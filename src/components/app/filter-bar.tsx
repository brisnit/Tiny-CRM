"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, SlidersHorizontal, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useSyncedState } from "@/lib/hooks";

export type FilterDef = {
  key: string;
  label: string;
  options: readonly { value: string; label: string }[];
};

/**
 * The shared list toolbar: quick views, search and filters. State lives in the
 * URL rather than component state, so a filtered list is shareable, survives a
 * refresh, and can be bookmarked as a saved view.
 */
export function FilterBar({
  views,
  filters = [],
  searchPlaceholder = "Search…",
  right,
  className,
}: {
  views?: { value: string; label: string; count?: number }[];
  filters?: FilterDef[];
  searchPlaceholder?: string;
  right?: React.ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [query, setQuery] = useSyncedState(params.get("q") ?? "");
  const [showFilters, setShowFilters] = React.useState(
    filters.some((f) => params.get(f.key)),
  );

  const update = React.useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (!value || value === "__none__" || value === "all") next.delete(key);
      else next.set(key, value);
      next.delete("page");
      router.replace(`${pathname}?${next.toString()}` as never, { scroll: false });
    },
    [params, pathname, router],
  );

  // Debounce search so typing does not fire a request per keystroke.
  React.useEffect(() => {
    const current = params.get("q") ?? "";
    if (query === current) return;
    const timer = setTimeout(() => update("q", query || null), 280);
    return () => clearTimeout(timer);
  }, [query, params, update]);

  const activeView = params.get("view") ?? views?.[0]?.value ?? "all";
  const activeFilters = filters.filter((f) => params.get(f.key));

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {views && views.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            {views.map((view) => (
              <button
                key={view.value}
                onClick={() => update("view", view.value === views[0]!.value ? null : view.value)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-medium transition-colors",
                  activeView === view.value
                    ? "bg-sunken text-body"
                    : "text-muted hover:bg-sunken/60 hover:text-body",
                )}
              >
                {view.label}
                {view.count !== undefined ? (
                  <span className="text-[11px] text-faint tabular">{view.count}</span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}

        <div className="ml-auto flex flex-1 items-center justify-end gap-2 sm:flex-none">
          <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 pl-8 text-[13px]"
            />
            {query ? (
              <button
                onClick={() => {
                  setQuery("");
                  update("q", null);
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-faint hover:bg-sunken hover:text-body"
                aria-label="Clear search"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>

          {filters.length > 0 ? (
            <button
              onClick={() => setShowFilters((s) => !s)}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors",
                activeFilters.length > 0 || showFilters
                  ? "border-brand-300 bg-brand-50/50 text-brand-800 dark:border-brand-800 dark:bg-brand-950/40 dark:text-brand-300"
                  : "border-hairline-strong text-muted hover:bg-sunken",
              )}
            >
              <SlidersHorizontal className="size-3.5" />
              Filters
              {activeFilters.length > 0 ? <span className="tabular">{activeFilters.length}</span> : null}
            </button>
          ) : null}

          {right}
        </div>
      </div>

      {showFilters && filters.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-hairline bg-panel p-2.5">
          {filters.map((filter) => (
            <div key={filter.key} className="min-w-[9rem] flex-1 sm:max-w-[13rem]">
              <OptionSelect
                size="sm"
                value={params.get(filter.key) ?? "__none__"}
                onValueChange={(value) => update(filter.key, value)}
                options={filter.options}
                emptyLabel={`All ${filter.label.toLowerCase()}`}
                placeholder={filter.label}
              />
            </div>
          ))}
          {activeFilters.length > 0 ? (
            <button
              onClick={() => {
                const next = new URLSearchParams(params.toString());
                for (const f of filters) next.delete(f.key);
                router.replace(`${pathname}?${next.toString()}` as never, { scroll: false });
              }}
              className="ml-auto inline-flex items-center gap-1 px-2 text-[12px] text-muted transition-colors hover:text-body"
            >
              <X className="size-3" />
              Clear
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Page navigation for long lists. */
export function Pagination({
  page,
  pageCount,
  total,
  noun,
}: {
  page: number;
  pageCount: number;
  total: number;
  noun: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  if (pageCount <= 1) {
    return (
      <p className="px-4 py-3 text-[12px] text-faint">
        {total.toLocaleString()} {noun}
        {total === 1 ? "" : "s"}
      </p>
    );
  }

  function goto(next: number) {
    const search = new URLSearchParams(params.toString());
    if (next <= 1) search.delete("page");
    else search.set("page", String(next));
    router.replace(`${pathname}?${search.toString()}` as never, { scroll: true });
  }

  return (
    <div className="flex items-center justify-between gap-3 border-t border-hairline px-4 py-2.5">
      <p className="text-[12px] text-faint">
        Page {page} of {pageCount} · {total.toLocaleString()} {noun}
        {total === 1 ? "" : "s"}
      </p>
      <div className="flex items-center gap-1.5">
        <button
          disabled={page <= 1}
          onClick={() => goto(page - 1)}
          className="rounded-lg border border-hairline px-2.5 py-1 text-[12px] font-medium text-muted transition-colors hover:bg-sunken disabled:opacity-40"
        >
          Previous
        </button>
        <button
          disabled={page >= pageCount}
          onClick={() => goto(page + 1)}
          className="rounded-lg border border-hairline px-2.5 py-1 text-[12px] font-medium text-muted transition-colors hover:bg-sunken disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
