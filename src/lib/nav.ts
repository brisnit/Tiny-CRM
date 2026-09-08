import type { LucideIcon } from "lucide-react";
import {
  BarChart3, Bot, Building2, CalendarDays, CheckSquare, FileText, FolderKanban,
  Home, Landmark, Settings, Target, Users,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Which count to show in the sidebar badge, if any. */
  badge?: "tasksToday" | "overdue";
  shortcut?: string;
};

export const PRIMARY_NAV: NavItem[] = [
  { href: "/home", label: "Home", icon: Home, shortcut: "G H" },
  { href: "/projects", label: "Projects", icon: FolderKanban, shortcut: "G P" },
  { href: "/contacts", label: "Contacts", icon: Users, shortcut: "G C" },
  { href: "/companies", label: "Companies", icon: Building2 },
  { href: "/deals", label: "Deals", icon: Target, shortcut: "G D" },
  { href: "/opportunities", label: "Opportunities", icon: Landmark },
  { href: "/tasks", label: "Tasks", icon: CheckSquare, badge: "overdue", shortcut: "G T" },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/notes", label: "Notes", icon: FileText },
];

/**
 * Navigation only advertises what a customer can actually finish.
 *
 * Automations and Files were in the sidebar and neither could be used. The
 * automations screen described what a rule is and offered no way to create one;
 * the files screen invited people to attach proposals and contracts with no
 * upload control, because `STORAGE_DRIVER` is `none`. A primary navigation
 * entry is a promise, and both were promising something the product does not do
 * yet.
 *
 * They are hidden rather than deleted: the routes, the data model and the
 * automation engine all still exist and still run — the outbox drives
 * automations today — so this is a change to what is offered, not to what has
 * been built. `BETA_HIDDEN` keeps the reason in one place rather than leaving
 * two commented-out lines for someone to restore without knowing why they went.
 */
export const BETA_HIDDEN = ["/automations", "/files"] as const;

export const SECONDARY_NAV: NavItem[] = [
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
];

export const FOOTER_NAV: NavItem[] = [{ href: "/settings", label: "Settings", icon: Settings }];

export const AI_NAV: NavItem = { href: "/ai", label: "Tiny AI", icon: Bot, shortcut: "⌘K" };

/** Longest-prefix match so /projects/abc highlights Projects, not Home. */
export function isActive(pathname: string, href: string) {
  if (href === "/home") return pathname === "/home" || pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
