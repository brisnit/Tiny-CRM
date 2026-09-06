"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Crosshair, X } from "lucide-react";

import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setProjectFocus } from "@/lib/actions/scope";
import { cn } from "@/lib/utils";

export type ProjectOption = { id: string; name: string; color: string; workspaceName: string };

/**
 * Project focus. Selecting a project puts the whole app into a contextual mode
 * where lists default to that initiative — the "work on one thing" switch.
 */
export function ProjectSwitcher({
  projects,
  focused,
  collapsed,
}: {
  projects: ProjectOption[];
  focused: string | null;
  collapsed?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const active = projects.find((p) => p.id === focused);

  function choose(next: string | null) {
    startTransition(async () => {
      await setProjectFocus(next);
      router.refresh();
    });
  }

  if (collapsed) {
    return (
      <button
        onClick={() => choose(null)}
        className={cn(
          "flex w-full justify-center rounded-lg py-1.5 text-faint transition-colors hover:bg-sunken",
          active && "text-brand-500",
        )}
        title={active ? `Focused: ${active.name}` : "No project focus"}
      >
        <Crosshair className="size-4" />
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-sunken",
            pending && "opacity-60",
          )}
        >
          <Crosshair className={cn("size-3.5 shrink-0", active ? "text-brand-500" : "text-faint")} />
          <span className={cn("truncate", active ? "font-medium text-body" : "text-muted")}>
            {active ? active.name : "All projects"}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>Focus on a project</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => choose(null)}>
            <span className="flex-1">All projects</span>
            {!focused ? <Check className="size-3.5 text-brand-500" /> : null}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="max-h-72 overflow-y-auto">
            {projects.map((p) => (
              <DropdownMenuItem key={p.id} onSelect={() => choose(p.id)}>
                <span className="size-2 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{p.name}</span>
                  <span className="block truncate text-[11px] text-faint">{p.workspaceName}</span>
                </span>
                {focused === p.id ? <Check className="size-3.5 shrink-0 text-brand-500" /> : null}
              </DropdownMenuItem>
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      {active ? (
        <button
          onClick={() => choose(null)}
          className="rounded-md p-1 text-faint transition-colors hover:bg-sunken hover:text-body"
          title="Clear project focus"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
