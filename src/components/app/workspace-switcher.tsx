"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Layers, Plus } from "lucide-react";

import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setScope } from "@/lib/actions/scope";
import { cn } from "@/lib/utils";

export type WorkspaceOption = { id: string; name: string; color: string; role: string };

export function WorkspaceSwitcher({
  workspaces,
  scope,
  collapsed,
}: {
  workspaces: WorkspaceOption[];
  scope: string;
  collapsed?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const active = workspaces.find((w) => w.id === scope);

  function choose(next: string) {
    startTransition(async () => {
      await setScope(next);
      router.refresh();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-sunken",
          pending && "opacity-60",
          collapsed && "justify-center px-0",
        )}
      >
        <span
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white"
          style={{ background: active?.color ?? "#1b1b1b" }}
          aria-hidden
        >
          {active ? active.name.charAt(0) : <Layers className="size-3.5" />}
        </span>
        {collapsed ? null : (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-body">
                {active ? active.name : "All Businesses"}
              </span>
              <span className="block truncate text-[11px] text-faint">
                {active ? "Workspace" : `${workspaces.length} workspaces`}
              </span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-faint" />
          </>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => choose("all")}>
          <Layers />
          <span className="flex-1">All Businesses</span>
          {scope === "all" ? <Check className="size-3.5 text-brand-500" /> : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {workspaces.map((w) => (
          <DropdownMenuItem key={w.id} onSelect={() => choose(w.id)}>
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: w.color }} aria-hidden />
            <span className="flex-1 truncate">{w.name}</span>
            {scope === w.id ? <Check className="size-3.5 text-brand-500" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push("/settings/workspaces")}>
          <Plus />
          New workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
