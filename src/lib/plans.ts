/**
 * Plans and the limits that make the free tier meaningful without making it
 * useless. Limits are enforced server-side in src/lib/actions/* — never only in
 * the UI — via assertWithinLimit().
 */

export type PlanId = "free" | "pro" | "lifetime";

export type PlanLimits = {
  workspaces: number;
  contacts: number;
  companies: number;
  deals: number;
  projects: number;
  opportunities: number;
  tasks: number;
  /** AI requests per calendar month. */
  aiRequestsPerMonth: number;
  automations: number;
  savedViews: number;
  customFields: number;
  seats: number;
};

export const UNLIMITED = Number.POSITIVE_INFINITY;

export type Plan = {
  id: PlanId;
  name: string;
  tagline: string;
  /** Price in cents. Lifetime is a one-time charge. */
  priceCents: number;
  cadence: "forever" | "month" | "once";
  limits: PlanLimits;
  features: string[];
  highlight?: string;
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    tagline: "Enough to run your first few clients.",
    priceCents: 0,
    cadence: "forever",
    limits: {
      workspaces: 1,
      contacts: 50,
      companies: 25,
      deals: 15,
      projects: 3,
      opportunities: 5,
      tasks: 100,
      aiRequestsPerMonth: 25,
      automations: 1,
      savedViews: 3,
      customFields: 3,
      seats: 1,
    },
    features: [
      "1 workspace",
      "50 contacts, 25 companies",
      "3 projects and 15 deals",
      "Tasks, notes and activity timeline",
      "25 Tiny AI requests a month",
      "CSV import and export",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "The whole product, month to month.",
    priceCents: 1400,
    cadence: "month",
    highlight: "Most popular",
    limits: {
      workspaces: UNLIMITED,
      contacts: UNLIMITED,
      companies: UNLIMITED,
      deals: UNLIMITED,
      projects: UNLIMITED,
      opportunities: UNLIMITED,
      tasks: UNLIMITED,
      aiRequestsPerMonth: 1000,
      automations: UNLIMITED,
      savedViews: UNLIMITED,
      customFields: UNLIMITED,
      seats: 5,
    },
    features: [
      "Unlimited workspaces, contacts and projects",
      "Multiple pipelines and opportunity tracking",
      "1,000 Tiny AI requests a month",
      "Automations, saved views and custom fields",
      "Email and calendar integrations",
      "Up to 5 seats",
    ],
  },
  lifetime: {
    id: "lifetime",
    name: "Lifetime",
    tagline: "Pay once. Keep it forever.",
    priceCents: 25000,
    cadence: "once",
    highlight: "Best value",
    limits: {
      workspaces: UNLIMITED,
      contacts: UNLIMITED,
      companies: UNLIMITED,
      deals: UNLIMITED,
      projects: UNLIMITED,
      opportunities: UNLIMITED,
      tasks: UNLIMITED,
      aiRequestsPerMonth: 2000,
      automations: UNLIMITED,
      savedViews: UNLIMITED,
      customFields: UNLIMITED,
      seats: 5,
    },
    features: [
      "Everything in Pro, permanently",
      "One payment, no renewal",
      "2,000 Tiny AI requests a month",
      "All future updates included",
      "Up to 5 seats",
    ],
  },
};

export const PLAN_ORDER: PlanId[] = ["free", "pro", "lifetime"];

export function planFor(id: string | null | undefined): Plan {
  return PLANS[(id ?? "free") as PlanId] ?? PLANS.free;
}

export function isPaid(id: string | null | undefined) {
  return planFor(id).id !== "free";
}

export type LimitKey = keyof PlanLimits;

export function limitFor(plan: string | null | undefined, key: LimitKey) {
  return planFor(plan).limits[key];
}

/** "17 of 50 contacts" — copy shared by settings, upgrade prompts and toasts. */
export function describeUsage(used: number, limit: number) {
  if (limit === UNLIMITED) return `${used.toLocaleString()} — unlimited`;
  return `${used.toLocaleString()} of ${limit.toLocaleString()}`;
}

export class PlanLimitError extends Error {
  constructor(
    readonly limitKey: LimitKey,
    readonly limit: number,
    readonly plan: PlanId,
  ) {
    super(
      `You have reached the ${LIMIT_NOUN[limitKey]} limit on the ${PLANS[plan].name} plan (${limit}). Upgrade to keep going.`,
    );
    this.name = "PlanLimitError";
  }
}

export const LIMIT_NOUN: Record<LimitKey, string> = {
  workspaces: "workspace",
  contacts: "contact",
  companies: "company",
  deals: "deal",
  projects: "project",
  opportunities: "opportunity",
  tasks: "task",
  aiRequestsPerMonth: "monthly Tiny AI",
  automations: "automation",
  savedViews: "saved view",
  customFields: "custom field",
  seats: "seat",
};
