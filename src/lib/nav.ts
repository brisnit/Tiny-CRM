import type { LucideIcon } from "lucide-react";
import {
  BarChart3, Bot, Building2, CalendarDays, CheckSquare, FileText, FolderKanban,
  Home, Landmark, Paperclip, Settings, Target, Users, Workflow,
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

export const SECONDARY_NAV: NavItem[] = [
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/automations", label: "Automations", icon: Workflow },
  { href: "/files", label: "Files", icon: Paperclip },
];

export const FOOTER_NAV: NavItem[] = [{ href: "/settings", label: "Settings", icon: Settings }];

export const AI_NAV: NavItem = { href: "/ai", label: "Tiny AI", icon: Bot, shortcut: "⌘K" };

/** Longest-prefix match so /projects/abc highlights Projects, not Home. */
export function isActive(pathname: string, href: string) {
  if (href === "/home") return pathname === "/home" || pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
