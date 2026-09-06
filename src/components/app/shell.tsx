"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  Bell, ChevronsLeft, ChevronsRight, LogOut, Menu, Monitor, Moon, Plus,
  Search, Settings, Sparkles, Sun, User as UserIcon, X, Zap,
} from "lucide-react";

import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/surface";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Logo, LogoMark } from "@/components/brand/logo";
import { WorkspaceSwitcher, type WorkspaceOption } from "@/components/app/workspace-switcher";
import { ProjectSwitcher, type ProjectOption } from "@/components/app/project-switcher";
import { CommandBar } from "@/components/app/command-bar";
import { QuickAddDialog, type QuickAddContext, type QuickAddKind } from "@/components/app/quick-add";
import { TinyAiPanel, type AiFocus } from "@/components/app/tiny-ai-panel";
import { NotificationsPanel, type NotificationItem } from "@/components/app/notifications";
import { FOOTER_NAV, PRIMARY_NAV, SECONDARY_NAV, isActive, type NavItem } from "@/lib/nav";
import { useStoredValue } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export type ShellUser = { id: string; name: string; email: string; avatarUrl: string | null; plan: string };

export type ShellData = {
  user: ShellUser;
  workspaces: WorkspaceOption[];
  projects: ProjectOption[];
  scope: string;
  projectFocus: string | null;
  counts: { overdue: number; tasksToday: number };
  notifications: NotificationItem[];
  unreadCount: number;
  quickAdd: QuickAddContext;
  ai: { providerLabel: string; modelBacked: boolean };
};

const SIDEBAR_KEY = "tc-sidebar-collapsed";
const THEMES = ["light", "dark", "system"] as const;

export function AppShell({ data, children }: { data: ShellData; children: React.ReactNode }) {
  const pathname = usePathname();
  const [collapsedPref, setCollapsedPref] = useStoredValue(SIDEBAR_KEY, "0", ["0", "1"] as const);
  const collapsed = collapsedPref === "1";
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [commandOpen, setCommandOpen] = React.useState(false);
  const [quickAddOpen, setQuickAddOpen] = React.useState(false);
  const [quickAddKind, setQuickAddKind] = React.useState<QuickAddKind>("task");
  const [aiOpen, setAiOpen] = React.useState(false);
  const [aiQuestion, setAiQuestion] = React.useState<string | null>(null);
  const [aiFocus, setAiFocus] = React.useState<AiFocus>(null);
  const [notificationsOpen, setNotificationsOpen] = React.useState(false);

  function toggleCollapsed() {
    setCollapsedPref(collapsed ? "0" : "1");
  }

  // Close the mobile nav whenever the route changes. Derived during render
  // (React's documented pattern) so the drawer never paints over the new page.
  const [lastPath, setLastPath] = React.useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    if (mobileOpen) setMobileOpen(false);
  }

  // Global shortcuts: ⌘K command bar, ⌘N quick add, ⌘/ Tiny AI.
  React.useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((o) => !o);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setQuickAddKind("task");
        setQuickAddOpen(true);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "/") {
        event.preventDefault();
        setAiQuestion(null);
        setAiOpen(true);
        return;
      }
      if (event.key === "Escape") setCommandOpen(false);
      if (typing) return;
      if (event.key === "?" ) {
        event.preventDefault();
        setCommandOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [quickAddPrefill, setQuickAddPrefill] = React.useState<QuickAddContext["prefill"]>(undefined);

  function openQuickAdd(kind: QuickAddKind, prefill?: QuickAddContext["prefill"]) {
    setQuickAddKind(kind);
    setQuickAddPrefill(prefill);
    setQuickAddOpen(true);
  }

  // Any page can open Quick Add by dispatching this event, which keeps server
  // components from needing access to shell state.
  React.useEffect(() => {
    function onRequest(event: Event) {
      const detail = (event as CustomEvent<{ kind: QuickAddKind; prefill?: QuickAddContext["prefill"] }>).detail;
      if (detail?.kind) openQuickAdd(detail.kind, detail.prefill);
    }
    window.addEventListener("tinycrm:quick-add", onRequest);
    return () => window.removeEventListener("tinycrm:quick-add", onRequest);
  }, []);

  // Pages can likewise ask Tiny AI a question, optionally about one record.
  React.useEffect(() => {
    function onAsk(event: Event) {
      const detail = (event as CustomEvent<{ question?: string; focus?: AiFocus }>).detail;
      setAiFocus(detail?.focus ?? null);
      setAiQuestion(detail?.question ?? null);
      setAiOpen(true);
    }
    window.addEventListener("tinycrm:ask-ai", onAsk);
    return () => window.removeEventListener("tinycrm:ask-ai", onAsk);
  }, []);

  function openAi(question: string) {
    setAiFocus(null);
    setAiQuestion(question);
    setAiOpen(true);
  }

  return (
    <div className="flex min-h-dvh bg-canvas">
      {/* Mobile scrim */}
      {mobileOpen ? (
        <button
          aria-label="Close navigation"
          className="fixed inset-0 z-40 bg-ink/25 backdrop-blur-[2px] lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex shrink-0 flex-col border-r border-hairline bg-panel transition-[width,transform] duration-200",
          "lg:sticky lg:top-0 lg:h-dvh lg:translate-x-0",
          collapsed ? "w-[68px]" : "w-[248px]",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className={cn("flex h-14 items-center gap-2 px-3", collapsed && "justify-center px-2")}>
          <Link href="/home" className="flex min-w-0 items-center gap-2">
            {collapsed ? <LogoMark className="size-7" title="Tiny CRM" /> : <Logo />}
          </Link>
          <button
            className="ml-auto rounded-md p-1.5 text-faint hover:bg-sunken hover:text-body lg:hidden"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className={cn("px-2 pb-2", collapsed && "px-1.5")}>
          <WorkspaceSwitcher workspaces={data.workspaces} scope={data.scope} collapsed={collapsed} />
        </div>

        <div className={cn("px-2 pb-3", collapsed && "px-1.5")}>
          <Button
            variant="brand"
            size={collapsed ? "icon-sm" : "sm"}
            className={cn("w-full gap-1.5", collapsed && "w-auto")}
            onClick={() => openQuickAdd("task")}
          >
            <Plus className="size-4" />
            {collapsed ? null : "Quick add"}
          </Button>
        </div>

        <nav className="flex-1 space-y-4 overflow-y-auto px-2 pb-3">
          <NavGroup items={PRIMARY_NAV} pathname={pathname} collapsed={collapsed} counts={data.counts} />

          {collapsed ? null : (
            <div className="space-y-1 px-1">
              <SectionLabel className="px-2 pb-1">Focus</SectionLabel>
              <ProjectSwitcher projects={data.projects} focused={data.projectFocus} />
            </div>
          )}

          <div className="space-y-1">
            {collapsed ? null : <SectionLabel className="px-3 pb-1">Manage</SectionLabel>}
            <NavGroup items={SECONDARY_NAV} pathname={pathname} collapsed={collapsed} counts={data.counts} />
          </div>
        </nav>

        <div className="space-y-1 border-t border-hairline p-2">
          <SidebarButton
            collapsed={collapsed}
            icon={<Sparkles className="size-4 text-brand-500" />}
            label="Tiny AI"
            hint="⌘/"
            onClick={() => {
              setAiFocus(null);
              setAiQuestion(null);
              setAiOpen(true);
            }}
          />
          <SidebarButton
            collapsed={collapsed}
            icon={<Bell className="size-4" />}
            label="Notifications"
            badge={data.unreadCount || undefined}
            onClick={() => setNotificationsOpen(true)}
          />
          <NavGroup items={FOOTER_NAV} pathname={pathname} collapsed={collapsed} counts={data.counts} />

          <UserMenu user={data.user} collapsed={collapsed} />

          <button
            onClick={toggleCollapsed}
            className={cn(
              "hidden w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-faint transition-colors hover:bg-sunken hover:text-body lg:flex",
              collapsed && "justify-center px-0",
            )}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
            {collapsed ? null : "Collapse"}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-hairline bg-canvas/85 px-3 backdrop-blur-md sm:px-5">
          <button
            className="rounded-lg p-2 text-muted hover:bg-sunken hover:text-body lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="size-4.5" />
          </button>

          <button
            onClick={() => setCommandOpen(true)}
            className="group flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full border border-hairline bg-panel px-3.5 text-left text-[13px] text-faint transition-colors hover:border-hairline-strong sm:max-w-md"
          >
            <Search className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Search or ask Tiny AI…</span>
            <kbd className="hidden shrink-0 rounded border border-hairline px-1.5 py-0.5 font-mono text-[10px] sm:block">
              ⌘K
            </kbd>
          </button>

          <div className="ml-auto flex items-center gap-1">
            {data.user.plan === "free" ? (
              <Button asChild size="sm" variant="outline" className="hidden gap-1.5 sm:inline-flex">
                <Link href="/settings/billing">
                  <Zap className="size-3.5 text-brand-500" />
                  Upgrade
                </Link>
              </Button>
            ) : null}
            <ThemeToggle />
            <Tooltip content="Notifications">
              <button
                onClick={() => setNotificationsOpen(true)}
                className="relative rounded-lg p-2 text-muted transition-colors hover:bg-sunken hover:text-body"
                aria-label="Notifications"
              >
                <Bell className="size-4" />
                {data.unreadCount > 0 ? (
                  <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-brand-500 ring-2 ring-canvas" />
                ) : null}
              </button>
            </Tooltip>
            <Tooltip content="Tiny AI · ⌘/">
              <button
                onClick={() => {
                  setAiFocus(null);
                  setAiQuestion(null);
                  setAiOpen(true);
                }}
                className="rounded-lg p-2 text-brand-600 transition-colors hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-950"
                aria-label="Tiny AI"
              >
                <Sparkles className="size-4" />
              </button>
            </Tooltip>
          </div>
        </header>

        <main className="min-w-0 flex-1">{children}</main>
      </div>

      {/* Floating Tiny AI button — mobile only, where the header icon is tight. */}
      <button
        onClick={() => {
          setAiFocus(null);
          setAiQuestion(null);
          setAiOpen(true);
        }}
        className="fixed bottom-5 right-5 z-30 flex size-12 items-center justify-center rounded-full bg-brand-500 text-white shadow-pop transition-transform hover:scale-105 active:scale-95 lg:hidden"
        aria-label="Ask Tiny AI"
      >
        <Sparkles className="size-5" />
      </button>

      {commandOpen ? (
        <CommandBar
          open
          onOpenChange={setCommandOpen}
          onQuickAdd={openQuickAdd}
          onAskAi={openAi}
          scope={data.scope}
        />
      ) : null}
      {quickAddOpen ? (
        <QuickAddDialog
          open
          onOpenChange={setQuickAddOpen}
          context={{ ...data.quickAdd, prefill: quickAddPrefill }}
          initialKind={quickAddKind}
        />
      ) : null}
      <TinyAiPanel
        open={aiOpen}
        onOpenChange={setAiOpen}
        scope={data.scope}
        initialQuestion={aiQuestion}
        focus={aiFocus}
        providerLabel={data.ai.providerLabel}
        modelBacked={data.ai.modelBacked}
      />
      <NotificationsPanel
        open={notificationsOpen}
        onOpenChange={setNotificationsOpen}
        notifications={data.notifications}
      />
    </div>
  );
}

function NavGroup({
  items, pathname, collapsed, counts,
}: {
  items: NavItem[];
  pathname: string;
  collapsed: boolean;
  counts: { overdue: number; tasksToday: number };
}) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        const badge = item.badge ? counts[item.badge] : 0;
        const link = (
          <Link
            href={item.href as never}
            className={cn(
              "group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors",
              active ? "bg-sunken text-body" : "text-muted hover:bg-sunken/70 hover:text-body",
              collapsed && "justify-center px-0",
            )}
          >
            <item.icon
              className={cn("size-4 shrink-0", active ? "text-brand-500" : "text-faint group-hover:text-muted")}
            />
            {collapsed ? null : (
              <>
                <span className="flex-1 truncate">{item.label}</span>
                {badge > 0 ? (
                  <Badge className="bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-900">
                    {badge}
                  </Badge>
                ) : null}
              </>
            )}
          </Link>
        );
        return (
          <li key={item.href}>
            {collapsed ? (
              <Tooltip content={item.label} side="right">
                {link}
              </Tooltip>
            ) : (
              link
            )}
          </li>
        );
      })}
    </ul>
  );
}

function SidebarButton({
  collapsed, icon, label, hint, badge, onClick,
}: {
  collapsed: boolean;
  icon: React.ReactNode;
  label: string;
  hint?: string;
  badge?: number;
  onClick: () => void;
}) {
  const button = (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-sunken hover:text-body",
        collapsed && "justify-center px-0",
      )}
    >
      <span className="shrink-0 text-faint">{icon}</span>
      {collapsed ? null : (
        <>
          <span className="flex-1 text-left">{label}</span>
          {badge ? (
            <Badge className="bg-brand-50 text-brand-700 ring-brand-200 dark:bg-brand-950 dark:text-brand-300 dark:ring-brand-900">
              {badge}
            </Badge>
          ) : hint ? (
            <span className="font-mono text-[10px] text-faint">{hint}</span>
          ) : null}
        </>
      )}
    </button>
  );
  return collapsed ? (
    <Tooltip content={label} side="right">
      {button}
    </Tooltip>
  ) : (
    button
  );
}

function UserMenu({ user, collapsed }: { user: ShellUser; collapsed: boolean }) {
  const router = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-sunken",
          collapsed && "justify-center px-0",
        )}
      >
        <Avatar name={user.name} src={user.avatarUrl} size="sm" />
        {collapsed ? null : (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-body">{user.name}</span>
            <span className="block truncate text-[11px] capitalize text-faint">{user.plan} plan</span>
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuLabel>{user.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push("/settings/profile")}>
          <UserIcon />
          Profile
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push("/settings")}>
          <Settings />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push("/settings/billing")}>
          <Zap />
          Plan &amp; billing
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem danger onSelect={() => void signOut({ callbackUrl: "/" })}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useStoredValue("tc-theme", "system", THEMES);

  function apply(next: (typeof THEMES)[number]) {
    setTheme(next);
    const dark = next === "dark" || (next === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  }

  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="rounded-lg p-2 text-muted transition-colors hover:bg-sunken hover:text-body"
        aria-label="Theme"
      >
        <Icon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuItem onSelect={() => apply("light")}>
          <Sun /> Light
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => apply("dark")}>
          <Moon /> Dark
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => apply("system")}>
          <Monitor /> System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
