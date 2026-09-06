/**
 * The schema stores enumerated values as plain strings so it runs unchanged on
 * SQLite and PostgreSQL. This module is the single source of truth for what
 * those strings may be, what they are called in the UI, and how they are
 * coloured. Zod schemas here are used to validate every write.
 */
import { z } from "zod";

export type Option<T extends string = string> = {
  value: T;
  label: string;
  /** Tailwind classes for the badge that renders this value. */
  tone: string;
  description?: string;
};

function optionMap<T extends string>(options: readonly Option<T>[]) {
  const byValue = new Map(options.map((o) => [o.value, o]));
  return {
    options,
    values: options.map((o) => o.value) as [T, ...T[]],
    get(value: string | null | undefined): Option<T> | undefined {
      return value ? byValue.get(value as T) : undefined;
    },
    label(value: string | null | undefined, fallback = "—") {
      return byValue.get(value as T)?.label ?? fallback;
    },
    tone(value: string | null | undefined) {
      return byValue.get(value as T)?.tone ?? TONE.neutral;
    },
  };
}

/** Badge tones. Chosen to read calmly against the warm off-white app canvas. */
export const TONE = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
  brand: "bg-brand-50 text-brand-800 ring-brand-200 dark:bg-brand-950 dark:text-brand-300 dark:ring-brand-900",
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900",
  blue: "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-900",
  violet: "bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:ring-violet-900",
  amber: "bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900",
  rose: "bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-900",
  stone: "bg-stone-100 text-stone-700 ring-stone-200 dark:bg-stone-800 dark:text-stone-300 dark:ring-stone-700",
} as const;

// --- People & accounts -----------------------------------------------------

export const RELATIONSHIP_TYPE = optionMap([
  { value: "client", label: "Client", tone: TONE.green },
  { value: "prospect", label: "Prospect", tone: TONE.blue },
  { value: "partner", label: "Partner", tone: TONE.violet },
  { value: "vendor", label: "Vendor", tone: TONE.stone },
  { value: "investor", label: "Investor", tone: TONE.amber },
  { value: "colleague", label: "Colleague", tone: TONE.neutral },
  { value: "other", label: "Other", tone: TONE.neutral },
] as const);

export const COMPANY_TYPE = optionMap([
  { value: "client", label: "Client", tone: TONE.green },
  { value: "prospect", label: "Prospect", tone: TONE.blue },
  { value: "partner", label: "Partner", tone: TONE.violet },
  { value: "vendor", label: "Vendor", tone: TONE.stone },
  { value: "investor", label: "Investor", tone: TONE.amber },
  { value: "other", label: "Other", tone: TONE.neutral },
] as const);

export const RELATIONSHIP_STATUS = optionMap([
  { value: "active", label: "Active", tone: TONE.green },
  { value: "prospect", label: "Prospect", tone: TONE.blue },
  { value: "past", label: "Past", tone: TONE.stone },
  { value: "cold", label: "Cold", tone: TONE.neutral },
] as const);

export const COMPANY_SIZE = optionMap([
  { value: "1-10", label: "1–10", tone: TONE.neutral },
  { value: "11-50", label: "11–50", tone: TONE.neutral },
  { value: "51-200", label: "51–200", tone: TONE.neutral },
  { value: "201-1000", label: "201–1,000", tone: TONE.neutral },
  { value: "1000+", label: "1,000+", tone: TONE.neutral },
] as const);

export const REVENUE_RANGE = optionMap([
  { value: "<1M", label: "Under $1M", tone: TONE.neutral },
  { value: "1M-10M", label: "$1M–$10M", tone: TONE.neutral },
  { value: "10M-50M", label: "$10M–$50M", tone: TONE.neutral },
  { value: "50M-250M", label: "$50M–$250M", tone: TONE.neutral },
  { value: "250M+", label: "$250M+", tone: TONE.neutral },
] as const);

export const LEAD_SOURCE = optionMap([
  { value: "referral", label: "Referral", tone: TONE.green },
  { value: "inbound", label: "Inbound", tone: TONE.blue },
  { value: "outbound", label: "Outbound", tone: TONE.violet },
  { value: "event", label: "Event", tone: TONE.amber },
  { value: "network", label: "Personal network", tone: TONE.brand },
  { value: "rfp_portal", label: "RFP portal", tone: TONE.stone },
  { value: "partner", label: "Partner", tone: TONE.violet },
  { value: "other", label: "Other", tone: TONE.neutral },
] as const);

/**
 * Relationship health. Computed in src/lib/scoring.ts, never stored, so it can
 * never drift from the underlying activity.
 */
export const RELATIONSHIP_STRENGTH = optionMap([
  { value: "strong", label: "Strong", tone: TONE.green, description: "Frequent, recent, two-way contact" },
  { value: "healthy", label: "Healthy", tone: TONE.brand, description: "Regular contact, nothing overdue" },
  { value: "cooling", label: "Cooling", tone: TONE.amber, description: "Contact has slowed noticeably" },
  { value: "at_risk", label: "At risk", tone: TONE.rose, description: "Long silence with open work" },
  { value: "new", label: "New", tone: TONE.blue, description: "Not enough history to judge yet" },
] as const);

// --- Projects --------------------------------------------------------------

export const PROJECT_PRIORITY = optionMap([
  { value: "low", label: "Low", tone: TONE.neutral },
  { value: "medium", label: "Medium", tone: TONE.blue },
  { value: "high", label: "High", tone: TONE.amber },
  { value: "urgent", label: "Urgent", tone: TONE.rose },
] as const);

export const PROJECT_HEALTH = optionMap([
  { value: "on_track", label: "On track", tone: TONE.green },
  { value: "at_risk", label: "At risk", tone: TONE.amber },
  { value: "off_track", label: "Off track", tone: TONE.rose },
  { value: "on_hold", label: "On hold", tone: TONE.stone },
] as const);

export const PROJECT_TYPE = optionMap([
  { value: "consulting", label: "Consulting", tone: TONE.blue },
  { value: "website", label: "Website", tone: TONE.violet },
  { value: "software", label: "Software", tone: TONE.brand },
  { value: "retainer", label: "Retainer", tone: TONE.green },
  { value: "partnership", label: "Partnership", tone: TONE.amber },
  { value: "internal", label: "Internal", tone: TONE.stone },
  { value: "other", label: "Other", tone: TONE.neutral },
] as const);

/** Seeded into every new workspace; users edit these in Settings → Statuses. */
export const DEFAULT_PROJECT_STATUSES = [
  { key: "idea", name: "Idea", color: "#94a3b8", isTerminal: false },
  { key: "discovery", name: "Discovery", color: "#38bdf8", isTerminal: false },
  { key: "proposal", name: "Proposal", color: "#818cf8", isTerminal: false },
  { key: "active", name: "Active", color: "#068C28", isTerminal: false, isDefault: true },
  { key: "waiting", name: "Waiting", color: "#f59e0b", isTerminal: false },
  { key: "at_risk", name: "At Risk", color: "#f43f5e", isTerminal: false },
  { key: "completed", name: "Completed", color: "#0f766e", isTerminal: true },
  { key: "archived", name: "Archived", color: "#a8a29e", isTerminal: true },
] as const;

// --- Pipelines, deals, opportunities ---------------------------------------

export const PIPELINE_KIND = optionMap([
  { value: "deal", label: "Deals", tone: TONE.brand },
  { value: "opportunity", label: "Opportunities", tone: TONE.violet },
] as const);

export const STAGE_KIND = optionMap([
  { value: "open", label: "Open", tone: TONE.blue },
  { value: "won", label: "Won", tone: TONE.green },
  { value: "lost", label: "Lost", tone: TONE.rose },
] as const);

export const DEFAULT_DEAL_STAGES = [
  { name: "New Lead", probability: 10, color: "#94a3b8", kind: "open" },
  { name: "Qualified", probability: 25, color: "#38bdf8", kind: "open" },
  { name: "Discovery", probability: 40, color: "#818cf8", kind: "open" },
  { name: "Proposal", probability: 60, color: "#a855f7", kind: "open" },
  { name: "Negotiation", probability: 75, color: "#f59e0b", kind: "open" },
  { name: "Verbal Yes", probability: 90, color: "#3DBE46", kind: "open" },
  { name: "Won", probability: 100, color: "#068C28", kind: "won" },
  { name: "Lost", probability: 0, color: "#f43f5e", kind: "lost" },
] as const;

export const DEFAULT_OPPORTUNITY_STAGES = [
  { name: "Identified", probability: 10, color: "#94a3b8", kind: "open" },
  { name: "Reviewing", probability: 25, color: "#38bdf8", kind: "open" },
  { name: "Go Decision", probability: 45, color: "#818cf8", kind: "open" },
  { name: "Drafting", probability: 60, color: "#a855f7", kind: "open" },
  { name: "Submitted", probability: 70, color: "#f59e0b", kind: "open" },
  { name: "Awarded", probability: 100, color: "#068C28", kind: "won" },
  { name: "Not Awarded", probability: 0, color: "#f43f5e", kind: "lost" },
] as const;

export const OPPORTUNITY_TYPE = optionMap([
  { value: "rfp", label: "RFP", tone: TONE.violet },
  { value: "rfi", label: "RFI", tone: TONE.blue },
  { value: "grant", label: "Grant", tone: TONE.green },
  { value: "partnership", label: "Partnership", tone: TONE.amber },
  { value: "sole_source", label: "Sole source", tone: TONE.brand },
  { value: "idiq", label: "IDIQ", tone: TONE.stone },
  { value: "other", label: "Other", tone: TONE.neutral },
] as const);

export const SUBMISSION_STATUS = optionMap([
  { value: "not_started", label: "Not started", tone: TONE.neutral },
  { value: "drafting", label: "Drafting", tone: TONE.blue },
  { value: "internal_review", label: "Internal review", tone: TONE.violet },
  { value: "submitted", label: "Submitted", tone: TONE.amber },
  { value: "won", label: "Won", tone: TONE.green },
  { value: "lost", label: "Lost", tone: TONE.rose },
  { value: "no_bid", label: "No bid", tone: TONE.stone },
] as const);

export const STRATEGIC_VALUE = optionMap([
  { value: "low", label: "Low", tone: TONE.neutral },
  { value: "medium", label: "Medium", tone: TONE.blue },
  { value: "high", label: "High", tone: TONE.green },
] as const);

export const COMPETITION_LEVEL = optionMap([
  { value: "low", label: "Low", tone: TONE.green },
  { value: "medium", label: "Medium", tone: TONE.amber },
  { value: "high", label: "High", tone: TONE.rose },
  { value: "unknown", label: "Unknown", tone: TONE.neutral },
] as const);

// --- Tasks -----------------------------------------------------------------

export const TASK_STATUS = optionMap([
  { value: "open", label: "Open", tone: TONE.neutral },
  { value: "in_progress", label: "In progress", tone: TONE.blue },
  { value: "done", label: "Done", tone: TONE.green },
  { value: "cancelled", label: "Cancelled", tone: TONE.stone },
] as const);

export const TASK_PRIORITY = PROJECT_PRIORITY;

export const RECURRENCE = optionMap([
  { value: "none", label: "Does not repeat", tone: TONE.neutral },
  { value: "daily", label: "Daily", tone: TONE.blue },
  { value: "weekly", label: "Weekly", tone: TONE.blue },
  { value: "biweekly", label: "Every 2 weeks", tone: TONE.blue },
  { value: "monthly", label: "Monthly", tone: TONE.blue },
  { value: "quarterly", label: "Quarterly", tone: TONE.blue },
] as const);

// --- Activity --------------------------------------------------------------

export const ACTIVITY_TYPE = optionMap([
  { value: "note", label: "Note", tone: TONE.neutral },
  { value: "call", label: "Call", tone: TONE.blue },
  { value: "meeting", label: "Meeting", tone: TONE.violet },
  { value: "email", label: "Email", tone: TONE.brand },
  { value: "task", label: "Task", tone: TONE.amber },
  { value: "file", label: "File", tone: TONE.stone },
  { value: "stage_change", label: "Stage change", tone: TONE.green },
  { value: "project_update", label: "Project update", tone: TONE.green },
  { value: "comment", label: "Comment", tone: TONE.neutral },
  { value: "ai_insight", label: "Tiny AI", tone: TONE.brand },
  { value: "created", label: "Created", tone: TONE.neutral },
  { value: "field_change", label: "Update", tone: TONE.neutral },
] as const);

// --- Roles, plans, entities ------------------------------------------------

export const WORKSPACE_ROLE = optionMap([
  { value: "owner", label: "Owner", tone: TONE.brand, description: "Full control, including billing" },
  { value: "admin", label: "Admin", tone: TONE.violet, description: "Manage settings, members and all records" },
  { value: "manager", label: "Manager", tone: TONE.blue, description: "Manage all records, not settings" },
  { value: "member", label: "Member", tone: TONE.green, description: "Create and edit records they own" },
  { value: "viewer", label: "Viewer", tone: TONE.neutral, description: "Read-only access" },
] as const);

/** Ranked so permission checks are a comparison rather than a lookup table. */
export const ROLE_RANK: Record<string, number> = {
  viewer: 0,
  member: 1,
  manager: 2,
  admin: 3,
  owner: 4,
};

export const ENTITY_TYPES = [
  "contact",
  "company",
  "deal",
  "project",
  "opportunity",
  "task",
  "note",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_LABEL: Record<EntityType, { one: string; many: string; href: string }> = {
  contact: { one: "Contact", many: "Contacts", href: "/contacts" },
  company: { one: "Company", many: "Companies", href: "/companies" },
  deal: { one: "Deal", many: "Deals", href: "/deals" },
  project: { one: "Project", many: "Projects", href: "/projects" },
  opportunity: { one: "Opportunity", many: "Opportunities", href: "/opportunities" },
  task: { one: "Task", many: "Tasks", href: "/tasks" },
  note: { one: "Note", many: "Notes", href: "/notes" },
};

export const CUSTOM_FIELD_TYPE = optionMap([
  { value: "text", label: "Text", tone: TONE.neutral },
  { value: "number", label: "Number", tone: TONE.neutral },
  { value: "currency", label: "Currency", tone: TONE.green },
  { value: "date", label: "Date", tone: TONE.blue },
  { value: "dropdown", label: "Dropdown", tone: TONE.violet },
  { value: "multiselect", label: "Multi-select", tone: TONE.violet },
  { value: "checkbox", label: "Checkbox", tone: TONE.neutral },
  { value: "url", label: "URL", tone: TONE.blue },
  { value: "email", label: "Email", tone: TONE.blue },
  { value: "user", label: "User", tone: TONE.brand },
] as const);

export const AUTOMATION_TRIGGER = optionMap([
  { value: "deal_stage_changed", label: "When a deal changes stage", tone: TONE.brand },
  { value: "project_status_changed", label: "When a project changes status", tone: TONE.green },
  { value: "contact_created", label: "When a contact is added", tone: TONE.blue },
  { value: "deal_inactive", label: "When a deal goes quiet", tone: TONE.amber },
  { value: "opportunity_deadline_near", label: "When an opportunity deadline approaches", tone: TONE.violet },
  { value: "task_overdue", label: "When a task becomes overdue", tone: TONE.rose },
] as const);

export const AUTOMATION_ACTION = optionMap([
  { value: "create_task", label: "Create a task", tone: TONE.blue },
  { value: "create_checklist", label: "Create a checklist", tone: TONE.violet },
  { value: "notify_owner", label: "Notify the owner", tone: TONE.amber },
  { value: "set_health", label: "Set project health", tone: TONE.green },
  { value: "add_tag", label: "Add a tag", tone: TONE.neutral },
] as const);

// --- Zod schemas used by every server action -------------------------------

export const zEnum = <T extends { values: [string, ...string[]] }>(map: T) =>
  z.enum(map.values);

export const zOptionalEnum = <T extends { values: [string, ...string[]] }>(map: T) =>
  z.enum(map.values).nullish();
