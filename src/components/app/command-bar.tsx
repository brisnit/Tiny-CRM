"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import {
  ArrowRight, BarChart3, Bot, Building2, CalendarDays, CheckSquare, CornerDownLeft,
  FileText, FolderKanban, Landmark, Loader2, Plus, Search, Settings, Sparkles, Target, Users,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { EntityType } from "@/lib/enums";
import type { QuickAddKind } from "@/components/app/quick-add";

type Hit = {
  id: string;
  type: EntityType;
  title: string;
  subtitle?: string | null;
  href: string;
};

const TYPE_META: Record<EntityType, { label: string; icon: React.ElementType; order: number }> = {
  contact: { label: "Contacts", icon: Users, order: 1 },
  company: { label: "Companies", icon: Building2, order: 2 },
  deal: { label: "Deals", icon: Target, order: 3 },
  project: { label: "Projects", icon: FolderKanban, order: 0 },
  opportunity: { label: "Opportunities", icon: Landmark, order: 4 },
  task: { label: "Tasks", icon: CheckSquare, order: 5 },
  note: { label: "Notes", icon: FileText, order: 6 },
};

type CommandAction = {
  id: string;
  label: string;
  icon: React.ElementType;
  keywords?: string;
  run: () => void;
  shortcut?: string;
};

/**
 * The command bar is the fastest path to anything: it searches every record
 * type, exposes the create actions, and hands anything it does not recognise to
 * Tiny AI as a question.
 */
export function CommandBar({
  open,
  onOpenChange,
  onQuickAdd,
  onAskAi,
  scope,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onQuickAdd: (kind: QuickAddKind) => void;
  onAskAi: (question: string) => void;
  scope: string;
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState<Hit[]>([]);
  const [loading, setLoading] = React.useState(false);


  const trimmed = query.trim();
  const searching = trimmed.length >= 2;
  // Results only count for the query that is currently typed.
  const visibleHits = React.useMemo(() => (searching ? hits : []), [searching, hits]);

  React.useEffect(() => {
    if (!open || !searching) return;
    const q = trimmed;
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (!cancelled) setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&scope=${scope}`);
        const json = (await res.json()) as { hits: Hit[] };
        if (!cancelled) setHits(json.hits ?? []);
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, searching, open, scope]);

  const go = React.useCallback(
    (href: string) => {
      onOpenChange(false);
      router.push(href as never);
    },
    [onOpenChange, router],
  );

  const actions: CommandAction[] = React.useMemo(
    () => [
      { id: "new-task", label: "Add task", icon: CheckSquare, keywords: "create todo", run: () => { onOpenChange(false); onQuickAdd("task"); } },
      { id: "new-contact", label: "Create contact", icon: Users, keywords: "add person new", run: () => { onOpenChange(false); onQuickAdd("contact"); } },
      { id: "new-company", label: "Create company", icon: Building2, keywords: "add organization account", run: () => { onOpenChange(false); onQuickAdd("company"); } },
      { id: "new-deal", label: "Create deal", icon: Target, keywords: "add opportunity revenue", run: () => { onOpenChange(false); onQuickAdd("deal"); } },
      { id: "new-project", label: "Create project", icon: FolderKanban, keywords: "add initiative", run: () => { onOpenChange(false); onQuickAdd("project"); } },
      { id: "new-note", label: "Write a note", icon: FileText, keywords: "capture add", run: () => { onOpenChange(false); onQuickAdd("note"); } },
      { id: "new-opportunity", label: "Track an opportunity", icon: Landmark, keywords: "rfp solicitation grant", run: () => { onOpenChange(false); onQuickAdd("opportunity"); } },
      { id: "new-meeting", label: "Log a meeting", icon: CalendarDays, keywords: "call activity", run: () => { onOpenChange(false); onQuickAdd("meeting"); } },
    ],
    [onOpenChange, onQuickAdd],
  );

  const navigation: CommandAction[] = React.useMemo(
    () => [
      { id: "go-home", label: "Go to Home", icon: BarChart3, run: () => go("/home"), shortcut: "G H" },
      { id: "go-projects", label: "Go to Projects", icon: FolderKanban, run: () => go("/projects"), shortcut: "G P" },
      { id: "go-contacts", label: "Go to Contacts", icon: Users, run: () => go("/contacts"), shortcut: "G C" },
      { id: "go-companies", label: "Go to Companies", icon: Building2, run: () => go("/companies") },
      { id: "go-deals", label: "Go to Deals", icon: Target, run: () => go("/deals"), shortcut: "G D" },
      { id: "go-opportunities", label: "Go to Opportunities", icon: Landmark, run: () => go("/opportunities") },
      { id: "go-tasks", label: "Show overdue tasks", icon: CheckSquare, keywords: "overdue due today", run: () => go("/tasks?view=overdue") },
      { id: "go-calendar", label: "Go to Calendar", icon: CalendarDays, run: () => go("/calendar") },
      { id: "go-notes", label: "Search notes", icon: FileText, run: () => go("/notes") },
      { id: "go-analytics", label: "Go to Analytics", icon: BarChart3, run: () => go("/analytics") },
      { id: "go-settings", label: "Open Settings", icon: Settings, run: () => go("/settings") },
    ],
    [go],
  );

  const grouped = React.useMemo(() => {
    const map = new Map<EntityType, Hit[]>();
    for (const hit of visibleHits) {
      const list = map.get(hit.type) ?? [];
      if (list.length < 5) list.push(hit);
      map.set(hit.type, list);
    }
    return Array.from(map.entries()).sort((a, b) => TYPE_META[a[0]].order - TYPE_META[b[0]].order);
  }, [visibleHits]);

  const showAsk = trimmed.length > 2;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center p-4 pt-[12vh]">
      <button
        aria-label="Close"
        className="fixed inset-0 bg-ink/25 backdrop-blur-[2px] dark:bg-black/60"
        onClick={() => onOpenChange(false)}
      />
      <Command
        loop
        shouldFilter={false}
        className="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-hairline bg-panel shadow-pop animate-in fade-in-0 zoom-in-95 duration-150"
      >
        <div className="flex items-center gap-2.5 border-b border-hairline px-4">
          {loading ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-faint" />
          ) : (
            <Search className="size-4 shrink-0 text-faint" />
          )}
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search or ask Tiny AI anything…"
            className="h-12 w-full bg-transparent text-[15px] text-body outline-none placeholder:text-faint"
          />
          <kbd className="hidden shrink-0 rounded border border-hairline px-1.5 py-0.5 text-[10px] font-medium text-faint sm:block">
            ESC
          </kbd>
        </div>

        <Command.List className="max-h-[min(60vh,480px)] overflow-y-auto p-2">
          <Command.Empty className="px-3 py-8 text-center text-[13px] text-faint">
            {loading ? "Searching…" : "No matches. Try asking Tiny AI instead."}
          </Command.Empty>

          {showAsk ? (
            <Command.Group heading={<GroupLabel>Tiny AI</GroupLabel>}>
              <Item
                onSelect={() => {
                  onOpenChange(false);
                  onAskAi(trimmed);
                }}
              >
                <Sparkles className="size-4 text-brand-500" />
                <span className="min-w-0 flex-1 truncate">
                  Ask Tiny AI: <span className="text-muted">“{trimmed}”</span>
                </span>
                <CornerDownLeft className="size-3.5 text-faint" />
              </Item>
            </Command.Group>
          ) : null}

          {grouped.map(([type, list]) => {
            const meta = TYPE_META[type];
            return (
              <Command.Group key={type} heading={<GroupLabel>{meta.label}</GroupLabel>}>
                {list.map((hit) => (
                  <Item key={hit.id} onSelect={() => go(hit.href)}>
                    <meta.icon className="size-4 text-faint" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{hit.title}</span>
                      {hit.subtitle ? (
                        <span className="block truncate text-[11px] text-faint">{hit.subtitle}</span>
                      ) : null}
                    </span>
                    <ArrowRight className="size-3.5 text-faint opacity-0 group-data-[selected=true]:opacity-100" />
                  </Item>
                ))}
              </Command.Group>
            );
          })}

          {!searching ? (
            <>
              <Command.Group heading={<GroupLabel>Create</GroupLabel>}>
                {actions.map((a) => (
                  <Item key={a.id} onSelect={a.run}>
                    <Plus className="size-4 text-faint" />
                    <span className="flex-1">{a.label}</span>
                  </Item>
                ))}
              </Command.Group>
              <Command.Group heading={<GroupLabel>Go to</GroupLabel>}>
                {navigation.map((a) => (
                  <Item key={a.id} onSelect={a.run}>
                    <a.icon className="size-4 text-faint" />
                    <span className="flex-1">{a.label}</span>
                    {a.shortcut ? (
                      <span className="text-[10px] tracking-widest text-faint">{a.shortcut}</span>
                    ) : null}
                  </Item>
                ))}
              </Command.Group>
              <Command.Group heading={<GroupLabel>Ask Tiny AI</GroupLabel>}>
                {[
                  "What do I need to do today?",
                  "Which deals need attention?",
                  "Who haven't I talked to in 30 days?",
                  "What projects are at risk?",
                ].map((question) => (
                  <Item
                    key={question}
                    onSelect={() => {
                      onOpenChange(false);
                      onAskAi(question);
                    }}
                  >
                    <Bot className="size-4 text-brand-500" />
                    <span className="flex-1">{question}</span>
                  </Item>
                ))}
              </Command.Group>
            </>
          ) : null}
        </Command.List>
      </Command>
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
      {children}
    </div>
  );
}

function Item({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) {
  return (
    <Command.Item
      onSelect={onSelect}
      className={cn(
        "group flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-body",
        "data-[selected=true]:bg-sunken",
      )}
    >
      {children}
    </Command.Item>
  );
}
