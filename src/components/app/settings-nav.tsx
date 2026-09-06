"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bot, CreditCard, Database, Layers, Plug, ShieldCheck, SlidersHorizontal, Tag, Target,
  Trash2, User, Workflow,
} from "lucide-react";

import { cn } from "@/lib/utils";

const GROUPS: { label: string; items: { href: string; label: string; icon: React.ElementType }[] }[] = [
  {
    label: "Account",
    items: [
      { href: "/settings/profile", label: "Profile", icon: User },
      { href: "/settings/security", label: "Security", icon: ShieldCheck },
      { href: "/settings/billing", label: "Plan & billing", icon: CreditCard },
    ],
  },
  {
    label: "Workspace",
    items: [
      { href: "/settings/workspaces", label: "Workspaces & roles", icon: Layers },
      { href: "/settings/pipelines", label: "Pipelines", icon: Target },
      { href: "/settings/statuses", label: "Project statuses", icon: Workflow },
      { href: "/settings/fields", label: "Custom fields", icon: SlidersHorizontal },
      { href: "/settings/tags", label: "Tags", icon: Tag },
    ],
  },
  {
    label: "Connections",
    items: [
      { href: "/settings/ai", label: "Tiny AI", icon: Bot },
      { href: "/settings/integrations", label: "Integrations", icon: Plug },
      { href: "/settings/data", label: "Import & export", icon: Database },
      { href: "/settings/trash", label: "Trash", icon: Trash2 },
    ],
  },
];

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav className="lg:w-56 lg:shrink-0">
      <div className="flex gap-4 overflow-x-auto pb-2 lg:block lg:space-y-5 lg:overflow-visible lg:pb-0">
        {GROUPS.map((group) => (
          <div key={group.label} className="shrink-0">
            <p className="mb-1.5 hidden px-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint lg:block">
              {group.label}
            </p>
            <ul className="flex gap-1 lg:block lg:space-y-0.5">
              {group.items.map((item) => {
                const active = pathname === item.href;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href as never}
                      className={cn(
                        "flex items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                        active ? "bg-sunken text-body" : "text-muted hover:bg-sunken/60 hover:text-body",
                      )}
                    >
                      <item.icon className={cn("size-3.5", active ? "text-brand-500" : "text-faint")} />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
