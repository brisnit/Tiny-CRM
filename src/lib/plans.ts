/**
 * Plans, the limits that make the free tier meaningful without making it
 * useless, and the capabilities each tier unlocks.
 *
 * Limits are enforced server-side in src/lib/actions/* — never only in the UI —
 * via assertWithinLimit(). The metered AI allowance is enforced by
 * reserveAiRequest(), which is atomic, because a read-then-write check is
 * bypassable by two concurrent requests and the thing it guards costs money.
 *
 * ## Scope: what "a limit" counts
 *
 * Billing is per **account**, not per workspace. One person pays once and that
 * entitlement covers every workspace they belong to, because `User.plan` is
 * where the plan lives and src/lib/entitlements.ts deliberately counts usage
 * across all of an actor's memberships. Every limit here is therefore
 * account-wide, with exactly one exception: `seats` is per workspace, and the
 * governing plan is the **workspace owner's**. See LIMIT_SCOPE.
 *
 * ## Legacy plans
 *
 * `legacy_pro` and `legacy_lifetime` are not purchasable and never appear in a
 * picker or on the pricing page. They exist so that accounts which already hold
 * the pre-Stripe `pro` or `lifetime` plan keep exactly the entitlements they
 * have today. Renaming a plan does not preserve access: the old Pro had no
 * record ceiling at all, and mapping it onto the new Pro's finite ceilings would
 * meet some accounts with a refusal on the first write after deploy. These two
 * rows are the thing that stops that.
 */

import { MODEL_RATES, worstRequestCeilingUsd } from "@/lib/ai/cost";

export type PlanId = "free" | "plus" | "pro" | "legacy_pro" | "legacy_lifetime";

export type PlanLimits = {
  workspaces: number;
  contacts: number;
  companies: number;
  deals: number;
  projects: number;
  opportunities: number;
  tasks: number;
  /**
   * Metered model requests per calendar month.
   *
   * Only requests that actually reach a paid provider count. The built-in
   * deterministic engine is unmetered and unlimited on every plan, including
   * Free — it makes no external request and costs nothing, so charging it
   * against a paid allowance exhausted an allowance nobody was billed for and
   * then took the page down with it.
   */
  aiRequestsPerMonth: number;
  automations: number;
  savedViews: number;
  customFields: number;
  /** Members per workspace, governed by the workspace owner's plan. */
  seats: number;
};

/**
 * Capabilities a plan unlocks, as distinct from a quantity it limits.
 *
 * A capability is gated by plan **and** by its feature flag, and both must pass.
 * The flag answers "is this built and rolled out here"; the plan answers "is
 * this account entitled to it". Conflating the two would either sell something
 * that is still dark or hand a paid feature to everyone the moment it ships.
 */
export type PlanCapabilities = {
  /** Uploading files at all. Requires the `files` flag and object storage. */
  fileUploads: boolean;
  /**
   * Asking questions about an uploaded PDF, answered only from that document
   * with page citations. Requires the `files`, `ai` and `documentAi` flags too.
   */
  documentQa: boolean;
};

export const UNLIMITED = Number.POSITIVE_INFINITY;

export type Plan = {
  id: PlanId;
  name: string;
  tagline: string;
  /** Price in cents, per `cadence`. */
  priceCents: number;
  cadence: "forever" | "month" | "once";
  /** False for legacy plans: resolvable and honoured, never sold. */
  purchasable: boolean;
  limits: PlanLimits;
  capabilities: PlanCapabilities;
  /** Advertised unconditionally. */
  features: string[];
  /**
   * Advertised only once the named feature flag is enabled globally.
   *
   * The plan may *grant* a capability before the product is ready to promise it.
   * Document question answering is the case this exists for: the entitlement is
   * part of Pro, the capability is still dark behind the `documentAi` flag, and
   * listing it on the pricing page before the flag is on would be selling
   * something nobody can use yet.
   *
   * Tying the copy to the same flag that turns the feature on means the promise
   * and the capability cannot drift: one switch moves both.
   */
  gatedFeatures?: { flag: string; text: string }[];
  highlight?: string;
};

/**
 * The AI allowances are not free parameters. Each is the largest whole number of
 * requests whose *worst case* — the enforced prompt budget, the largest output
 * cap, and both charged attempts — stays inside MAX_AI_SHARE_OF_NET of the plan's
 * revenue after Stripe fees, at the configured model's published rates.
 *
 * At claude-opus-5 that works out to 30 for Plus and 60 for Pro.
 * tests/unit/ai-cost-model.test.ts recomputes it and fails if a model change, a
 * raised output cap or a widened prompt budget makes these numbers unaffordable.
 * Free carries no revenue at all, so its 10 is a deliberate acquisition cost,
 * bounded per account and reported in docs/AI-COST-MODEL.md.
 */
const AI_FREE = 10;
const AI_PLUS = 30;
const AI_PRO = 60;

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    tagline: "Enough to run your first few clients.",
    priceCents: 0,
    cadence: "forever",
    purchasable: true,
    limits: {
      workspaces: 1,
      contacts: 100,
      companies: 50,
      deals: 25,
      projects: 5,
      opportunities: 10,
      tasks: 200,
      aiRequestsPerMonth: AI_FREE,
      automations: 1,
      savedViews: 3,
      customFields: 3,
      seats: 1,
    },
    capabilities: { fileUploads: false, documentQa: false },
    features: [
      "1 workspace, just you",
      "100 contacts and 50 companies",
      "5 projects, 25 deals, 200 tasks",
      "Tasks, notes and the activity timeline",
      "Unlimited built-in insights — scores, momentum, duplicates, what has gone quiet",
      `${AI_FREE} Tiny AI model answers a month`,
      "CSV and spreadsheet import, export any time",
    ],
  },
  plus: {
    id: "plus",
    name: "Plus",
    tagline: "The everyday plan for running your own business.",
    priceCents: 1000,
    cadence: "month",
    purchasable: true,
    highlight: "Most popular",
    limits: {
      workspaces: 3,
      contacts: 2_000,
      companies: 750,
      deals: 400,
      projects: 75,
      opportunities: 200,
      tasks: 4_000,
      aiRequestsPerMonth: AI_PLUS,
      automations: 10,
      savedViews: 25,
      customFields: 20,
      seats: 3,
    },
    capabilities: { fileUploads: true, documentQa: false },
    features: [
      "3 workspaces, up to 3 people in each",
      "2,000 contacts and 750 companies",
      "75 projects, 400 deals, 4,000 tasks",
      "File attachments on any record",
      `${AI_PLUS} Tiny AI model answers a month`,
      "20 custom fields, multiple pipelines",
      "Cancel any time, no contract",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "More room, more people, more of everything.",
    priceCents: 2000,
    cadence: "month",
    purchasable: true,
    highlight: "Most capable",
    limits: {
      workspaces: 10,
      contacts: 5_000,
      companies: 2_000,
      deals: 1_200,
      projects: 200,
      opportunities: 600,
      tasks: 10_000,
      aiRequestsPerMonth: AI_PRO,
      automations: 50,
      savedViews: 100,
      customFields: 50,
      seats: 10,
    },
    // documentQa is true here, and still dark until the `documentAi` flag is
    // enabled. The plan grants the entitlement; the flag decides whether the
    // capability exists yet. Advertising copy is gated on the flag, not on this.
    capabilities: { fileUploads: true, documentQa: true },
    features: [
      "Everything in Plus, with more room",
      "10 workspaces, up to 10 people in each",
      "5,000 contacts and 2,000 companies",
      "200 projects, 1,200 deals, 10,000 tasks",
      `${AI_PRO} Tiny AI model answers a month`,
      "50 custom fields",
    ],
    gatedFeatures: [
      {
        flag: "documentAi",
        text: "Ask questions about an uploaded PDF, answered from that document with page citations",
      },
    ],
  },

  // --- Legacy. Not sold. Entitlements preserved exactly as they were. -------

  legacy_pro: {
    id: "legacy_pro",
    name: "Pro (legacy)",
    tagline: "Your original Pro plan, unchanged.",
    priceCents: 1400,
    cadence: "month",
    purchasable: false,
    limits: {
      workspaces: UNLIMITED,
      contacts: UNLIMITED,
      companies: UNLIMITED,
      deals: UNLIMITED,
      projects: UNLIMITED,
      opportunities: UNLIMITED,
      tasks: UNLIMITED,
      // Preserved at the original figure. This is a standing cost exposure on a
      // plan nobody is being charged for — see docs/AI-COST-MODEL.md, "Legacy
      // allowances" — and reducing it is a decision for the account owner, not
      // something to slip into a pricing change.
      aiRequestsPerMonth: 1_000,
      automations: UNLIMITED,
      savedViews: UNLIMITED,
      customFields: UNLIMITED,
      seats: 5,
    },
    capabilities: { fileUploads: true, documentQa: true },
    features: ["Your original Pro entitlements, preserved"],
  },
  legacy_lifetime: {
    id: "legacy_lifetime",
    name: "Lifetime (legacy)",
    tagline: "Paid once. Yours permanently.",
    priceCents: 25_000,
    cadence: "once",
    purchasable: false,
    limits: {
      workspaces: UNLIMITED,
      contacts: UNLIMITED,
      companies: UNLIMITED,
      deals: UNLIMITED,
      projects: UNLIMITED,
      opportunities: UNLIMITED,
      tasks: UNLIMITED,
      aiRequestsPerMonth: 2_000,
      automations: UNLIMITED,
      savedViews: UNLIMITED,
      customFields: UNLIMITED,
      seats: 5,
    },
    capabilities: { fileUploads: true, documentQa: true },
    features: ["Everything you paid once for, preserved"],
  },
};

/** The plans offered for sale, in the order they are shown. */
export const PLAN_ORDER: PlanId[] = ["free", "plus", "pro"];

/** Every plan id, including the legacy ones a stored row may still hold. */
export const ALL_PLAN_IDS = Object.keys(PLANS) as PlanId[];

/**
 * Where each pre-Stripe plan value maps. Applied by the migration in
 * scripts/migrate-legacy-plans.mjs, never implicitly at read time: a silent
 * remap would make the stored value and the honoured entitlement disagree, and
 * the audit trail would show neither.
 */
export const LEGACY_PLAN_MAPPING: Readonly<Record<string, PlanId>> = {
  pro: "legacy_pro",
  lifetime: "legacy_lifetime",
};

/**
 * Whether each limit is counted across the whole account or within one
 * workspace. Surfaced in the UI so "3 workspaces" and "3 people in each" are not
 * read as the same kind of number.
 */
export const LIMIT_SCOPE: Readonly<Record<LimitKey, "account" | "workspace">> = {
  workspaces: "account",
  contacts: "account",
  companies: "account",
  deals: "account",
  projects: "account",
  opportunities: "account",
  tasks: "account",
  aiRequestsPerMonth: "account",
  automations: "account",
  savedViews: "account",
  customFields: "account",
  seats: "workspace",
};

/**
 * Limits whose feature has a write path and is therefore actually enforced.
 *
 * `automations` and `savedViews` have no create path anywhere in the codebase,
 * so their counts are always zero. They keep their limit entries so a future
 * write path has a ceiling to check, but they are not advertised and not shown
 * as usage — a progress bar reading "0 of 10" for something you cannot create
 * is worse than no bar.
 */
export const ENFORCED_LIMITS: readonly LimitKey[] = [
  "workspaces", "contacts", "companies", "deals", "projects",
  "opportunities", "tasks", "customFields", "aiRequestsPerMonth", "seats",
];

/**
 * Pre-Stripe plan ids that still resolve, so a deploy cannot strip an account.
 *
 * ## Why this exists
 *
 * The rename is a vocabulary change across a database and a deployment, and
 * neither can change at the same instant as the other. Both orderings were tested
 * by running the *deployed* `planFor` against the migrated values:
 *
 *   - **Migrate first.** The deployed code does not know `legacy_lifetime` or
 *     `legacy_pro`, so `planFor` falls back to Free and an unlimited account is
 *     instantly capped at 50 contacts and 25 AI requests.
 *   - **Deploy first.** The new vocabulary dropped the key `lifetime`, so a stored
 *     `lifetime` likewise falls back to Free.
 *
 * This alias fixes the second case: the new code understands the old id and
 * resolves it to the preserved legacy plan, so deploying before migrating takes
 * nothing away. The migration then rewrites the stored value at leisure, and the
 * alias can be deleted afterwards.
 *
 * ## Why `pro` is deliberately **not** aliased
 *
 * `pro` means two different things either side of this change — the old unlimited
 * plan, and the new $20 tier with finite ceilings. An alias would have to pick
 * one, and picking "legacy" would hand unlimited records to every future Pro
 * subscriber. So `pro` is resolved by the migration rather than by an alias, and
 * the ordering note in docs/STRIPE-SETUP.md says to run it promptly after the
 * deploy. The exposure in between is bounded: a stored `pro` resolves to the new
 * Pro's ceilings, which is a reduction rather than a loss — no data is deleted,
 * and the migration restores the unlimited ceilings when it runs.
 */
export const PRE_STRIPE_PLAN_ALIASES: Readonly<Record<string, PlanId>> = {
  lifetime: "legacy_lifetime",
};

export function planFor(id: string | null | undefined): Plan {
  const stored = id ?? "free";
  const resolved = PRE_STRIPE_PLAN_ALIASES[stored] ?? stored;
  return PLANS[resolved as PlanId] ?? PLANS.free;
}

export function isPaid(id: string | null | undefined) {
  return planFor(id).id !== "free";
}

/** True for a plan that is still offered for sale. */
export function isPurchasable(id: string | null | undefined) {
  return planFor(id).purchasable;
}

export type LimitKey = keyof PlanLimits;
export type CapabilityKey = keyof PlanCapabilities;

export function limitFor(plan: string | null | undefined, key: LimitKey) {
  return planFor(plan).limits[key];
}

/** Whether the plan grants a capability, ignoring feature flags. */
export function planGrants(plan: string | null | undefined, key: CapabilityKey): boolean {
  return planFor(plan).capabilities[key];
}

/**
 * The feature lines a plan may actually advertise right now.
 *
 * `enabledFlags` is the set of flags the caller has already resolved — the
 * surfaces that show pricing are server components, and resolving flags is a
 * database read, so it is done once per render and passed in rather than
 * re-queried per plan.
 */
export function advertisedFeatures(plan: Plan, enabledFlags: readonly string[]): string[] {
  const gated = (plan.gatedFeatures ?? [])
    .filter((f) => enabledFlags.includes(f.flag))
    .map((f) => f.text);
  return [...plan.features, ...gated];
}

/** "17 of 50 contacts" — copy shared by settings, upgrade prompts and toasts. */
export function describeUsage(used: number, limit: number) {
  if (limit === UNLIMITED) return `${used.toLocaleString()} — unlimited`;
  return `${used.toLocaleString()} of ${limit.toLocaleString()}`;
}

/** Monthly price as "$10", for copy. Zero renders as "$0". */
export function priceLabel(plan: Plan) {
  return `$${(plan.priceCents / 100).toLocaleString()}`;
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

/**
 * Raised when the monthly metered-AI allowance is spent.
 *
 * Separate from PlanLimitError because the remedy and the copy differ: nothing
 * is over capacity, a monthly allowance has run out, the built-in engine still
 * works, and it refills on the first of the month.
 */
export class AiAllowanceError extends Error {
  constructor(
    readonly limit: number,
    readonly plan: PlanId,
  ) {
    super(
      `You have used all ${limit} Tiny AI model answers on the ${PLANS[plan].name} plan this month. ` +
        `Built-in insights keep working, and the allowance resets on the 1st.`,
    );
    this.name = "AiAllowanceError";
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

/**
 * Re-exported so a caller reasoning about what a plan costs to serve does not
 * have to know that the rate table lives in the AI module.
 */
export { MODEL_RATES, worstRequestCeilingUsd };
