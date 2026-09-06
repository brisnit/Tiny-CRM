import * as React from "react";
import {
  Bell, CheckSquare, FolderKanban, Home, Landmark, Search, Sparkles, Target, Users,
} from "lucide-react";

import { LogoMark } from "@/components/brand/logo";

/**
 * An honest, hand-built rendering of the real app shell — same layout, type
 * scale and palette as the product. It is not a screenshot, so it stays sharp,
 * themes correctly, and never goes stale relative to the UI it depicts.
 */
export function ProductPreview() {
  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-panel shadow-pop">
      {/* Window chrome */}
      <div className="flex items-center gap-2 border-b border-hairline bg-sunken/60 px-3 py-2">
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-hairline-strong" />
          <span className="size-2.5 rounded-full bg-hairline-strong" />
          <span className="size-2.5 rounded-full bg-hairline-strong" />
        </span>
        <span className="mx-auto flex items-center gap-1.5 rounded-full border border-hairline bg-panel px-3 py-0.5 text-[10px] text-faint">
          <Search className="size-2.5" />
          Search or ask Tiny AI…
        </span>
      </div>

      <div className="flex min-h-[380px]">
        {/* Sidebar */}
        <div className="hidden w-44 shrink-0 flex-col gap-3 border-r border-hairline p-3 sm:flex">
          <div className="flex items-center gap-1.5">
            <LogoMark className="size-5" />
            <span className="text-[11px] font-extrabold tracking-[-0.03em]">
              <span className="text-brand-800 dark:text-white">tiny</span>
              <span className="text-brand-400"> crm</span>
            </span>
          </div>

          <div className="flex items-center gap-1.5 rounded-md px-1.5 py-1">
            <span className="flex size-4 items-center justify-center rounded bg-brand-500 text-[8px] font-bold text-white">
              A
            </span>
            <span className="truncate text-[10px] font-semibold text-body">Artifact Intelligence</span>
          </div>

          <div className="rounded-full bg-brand-500 px-2 py-1 text-center text-[10px] font-medium text-white">
            + Quick add
          </div>

          <ul className="space-y-0.5">
            {[
              { icon: Home, label: "Home", active: true },
              { icon: FolderKanban, label: "Projects" },
              { icon: Users, label: "Contacts" },
              { icon: Target, label: "Deals" },
              { icon: Landmark, label: "Opportunities" },
              { icon: CheckSquare, label: "Tasks", badge: "3" },
            ].map((item) => (
              <li
                key={item.label}
                className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[10px] ${
                  item.active ? "bg-sunken font-medium text-body" : "text-muted"
                }`}
              >
                <item.icon className={`size-3 ${item.active ? "text-brand-500" : "text-faint"}`} />
                <span className="flex-1">{item.label}</span>
                {item.badge ? (
                  <span className="rounded bg-rose-100 px-1 text-[8px] font-semibold text-rose-700 dark:bg-rose-950 dark:text-rose-300">
                    {item.badge}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1 space-y-3 p-3 sm:p-4">
          {/* Brief */}
          <div className="relative overflow-hidden rounded-lg border border-hairline bg-panel p-3">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-brand-50/70 to-transparent dark:from-brand-950/40"
            />
            <div className="relative">
              <div className="flex items-center gap-1.5">
                <span className="flex size-4 items-center justify-center rounded bg-brand-500 text-white">
                  <Sparkles className="size-2.5" />
                </span>
                <span className="text-[11px] font-semibold text-body">Good morning, Bris</span>
              </div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-muted">
                Here&apos;s what deserves your attention today: 3 overdue tasks, 2 deals losing momentum, 1 project
                at risk and 4 contacts gone quiet.
              </p>
              <p className="mt-1.5 text-[10px] leading-relaxed text-body">
                <span className="font-semibold">Start here</span> — Follow up with Provost Okonkwo on the Phase 2
                budget. Third follow-up, 3 days overdue.
              </p>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-4 divide-x divide-hairline overflow-hidden rounded-lg border border-hairline">
            {[
              { label: "Pipeline", value: "$1.1M", tone: "text-brand-600 dark:text-brand-400" },
              { label: "Forecast", value: "$412K", tone: "text-body" },
              { label: "Due today", value: "3", tone: "text-rose-600 dark:text-rose-400" },
              { label: "Projects", value: "12", tone: "text-body" },
            ].map((stat) => (
              <div key={stat.label} className="p-2">
                <div className="text-[8px] font-semibold uppercase tracking-wider text-faint">{stat.label}</div>
                <div className={`mt-1 text-sm font-semibold tabular ${stat.tone}`}>{stat.value}</div>
              </div>
            ))}
          </div>

          {/* Table */}
          <div className="overflow-hidden rounded-lg border border-hairline">
            <div className="border-b border-hairline bg-sunken/40 px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-wider text-faint">
              Deals that need a push
            </div>
            <ul className="divide-y divide-hairline">
              {[
                { name: "Fuller — Phase 2", company: "Fuller Seminary", value: "$145K", state: "Stalled", tone: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300" },
                { name: "Verde Grocers Pilot", company: "Verde Grocers", value: "$30K", state: "Stalled", tone: "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300" },
                { name: "APU — Retention Pilot", company: "Azusa Pacific", value: "$68K", state: "Slowing", tone: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
              ].map((row) => (
                <li key={row.name} className="flex items-center gap-2 px-2.5 py-1.5">
                  <span className="size-1.5 shrink-0 rounded-full bg-brand-400" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10px] font-medium text-body">{row.name}</span>
                    <span className="block truncate text-[9px] text-faint">{row.company}</span>
                  </span>
                  <span className={`shrink-0 rounded px-1 py-0.5 text-[8px] font-medium ${row.tone}`}>
                    {row.state}
                  </span>
                  <span className="w-12 shrink-0 text-right text-[10px] font-medium tabular text-body">
                    {row.value}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Right rail */}
        <div className="hidden w-40 shrink-0 space-y-2 border-l border-hairline p-3 lg:block">
          <div className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider text-faint">
            <Bell className="size-2.5" />
            This week
          </div>
          {[
            { day: "Today", time: "10:00", title: "BBOP check-in" },
            { day: "Tue", time: "1:00", title: "Fuller demo" },
            { day: "Wed", time: "9:00", title: "SJSU proposal" },
            { day: "Fri", time: "11:00", title: "Cascade partners" },
          ].map((event) => (
            <div key={event.title} className="flex gap-2">
              <div className="w-7 shrink-0 text-right">
                <div className="text-[8px] uppercase text-faint">{event.day}</div>
                <div className="text-[9px] font-medium tabular text-body">{event.time}</div>
              </div>
              <div className="min-w-0 flex-1 border-l border-hairline pl-2">
                <div className="truncate text-[10px] text-body">{event.title}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
