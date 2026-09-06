import "server-only";

import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/logger";

/**
 * Per-workspace AI privacy.
 *
 * The previous hardening report identified that CRM content was sent to a model
 * provider with **no per-workspace opt-out**. That is the wrong default for this
 * product specifically: the premise is that one person runs several businesses
 * in one account, and those businesses do not share obligations. A consultancy
 * may be free to use a hosted model on its own pipeline and contractually
 * forbidden from doing so on a client's.
 *
 * So the setting is per workspace, not per account.
 *
 * ---------------------------------------------------------------------------
 * The modes
 * ---------------------------------------------------------------------------
 *
 *   disabled  No CRM content leaves the deployment. The deterministic engine
 *             still runs, so relationship scoring, deal momentum, stall
 *             detection, the cleanup scan and the daily brief all keep working —
 *             they never needed a model. What is lost is open-ended answers and
 *             free-text extraction.
 *
 *   enabled   Authorised context may be sent to the configured provider. This is
 *             the default, and the settings screen says plainly which provider,
 *             which model, and what kinds of data.
 *
 *   private   Reserved for a provider under an enterprise or zero-retention
 *             agreement. **Behaves exactly as `disabled` until such a provider
 *             is configured**, because a mode that silently degraded to `enabled`
 *             would be worse than not offering it: it would send data to a
 *             standard endpoint while the workspace believed otherwise.
 */

export const AI_MODES = ["disabled", "enabled", "private"] as const;
export type AiMode = (typeof AI_MODES)[number];

export const AI_MODE_LABELS: Record<AiMode, { title: string; description: string }> = {
  disabled: {
    title: "AI off",
    description:
      "No CRM content leaves Tiny CRM. Scoring, momentum, stall detection and the " +
      "daily brief still work — they are computed here, not by a model.",
  },
  enabled: {
    title: "AI on",
    description:
      "A bounded slice of this workspace's records may be sent to the configured " +
      "provider to answer questions and write summaries.",
  },
  private: {
    title: "Private model only",
    description:
      "AI runs only against a provider under an enterprise or zero-retention " +
      "agreement. Behaves as off until one is configured.",
  },
};

export function isAiMode(value: string): value is AiMode {
  return (AI_MODES as readonly string[]).includes(value);
}

export type AiPermission = {
  /** May a model be called for this workspace at all? */
  allowed: boolean;
  /** May CRM content be included in what is sent? */
  mayTransmitContent: boolean;
  mode: AiMode;
  /** Plain-language reason, shown to the user rather than only logged. */
  reason: string;
};

/**
 * Decides what AI may do for one workspace.
 *
 * Read before any retrieval and again before any provider call, so a workspace
 * switched to `disabled` stops transmitting immediately rather than at the end of
 * a cached window.
 */
export async function aiPermission(workspaceId: string): Promise<AiPermission> {
  const workspace = await db.workspace.findUnique({
    where: { id: workspaceId },
    select: { aiMode: true },
  });

  const mode: AiMode = workspace && isAiMode(workspace.aiMode) ? workspace.aiMode : "enabled";
  const provider = providerProfile();

  if (mode === "disabled") {
    return {
      allowed: true, // the deterministic engine still runs
      mayTransmitContent: false,
      mode,
      reason: "AI is off for this workspace. Nothing is sent to a provider.",
    };
  }

  if (mode === "private" && !provider.enterpriseControls) {
    // Fails closed, deliberately.
    return {
      allowed: true,
      mayTransmitContent: false,
      mode,
      reason:
        `This workspace is set to private-model only, and the configured provider ` +
        `(${provider.label}) is not under an enterprise agreement. Nothing is sent.`,
    };
  }

  if (provider.id === "offline") {
    return {
      allowed: true,
      mayTransmitContent: false,
      mode,
      reason: "No model provider is configured; the built-in engine is answering.",
    };
  }

  return {
    allowed: true,
    mayTransmitContent: true,
    mode,
    reason: `CRM context may be sent to ${provider.label}.`,
  };
}

/**
 * Asserts that content may be transmitted, for the paths that require a model.
 *
 * Called at the top of every provider-backed action. The deterministic paths do
 * not call it, which is what keeps them working when AI is off.
 */
export async function assertMayTransmit(workspaceId: string): Promise<void> {
  const permission = await aiPermission(workspaceId);
  if (permission.mayTransmitContent) return;

  log.info("AI transmission refused by workspace policy", { workspaceId, mode: permission.mode });
  throw new AppError("forbidden", permission.reason, {
    meta: { reason: "ai_disabled", mode: permission.mode },
  });
}

// ---------------------------------------------------------------------------
// Provider capabilities
// ---------------------------------------------------------------------------

/**
 * What a provider can be relied on to do.
 *
 * **None of these claims zero retention.** Zero retention is a property of a
 * *contract and a configuration*, not of a vendor — an account without the
 * relevant agreement gets standard retention from the same endpoint. Claiming it
 * from a capability table would be exactly the kind of statement this project
 * has been asked not to make.
 *
 * `zeroRetentionAvailable` therefore means "this provider offers such an
 * arrangement to customers who have one", and `enterpriseControls` is false
 * until an operator sets `AI_ENTERPRISE_AGREEMENT=true` to assert that they
 * actually hold one. The application never infers it.
 */
export type ProviderProfile = {
  id: string;
  label: string;
  model: string | null;
  /** Whether any CRM content leaves the deployment at all. */
  transmitsContent: boolean;
  /** The provider offers a zero-retention arrangement to eligible customers. */
  zeroRetentionAvailable: boolean;
  /** The operator has asserted they hold such an agreement. Never inferred. */
  enterpriseControls: boolean;
  regionalProcessingAvailable: boolean;
  supportsToolCalling: boolean;
  supportsStructuredOutput: boolean;
  /** Where to read the vendor's actual terms. */
  termsUrl: string | null;
};

const PROFILES: Record<string, Omit<ProviderProfile, "enterpriseControls" | "model">> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    transmitsContent: true,
    zeroRetentionAvailable: true,
    regionalProcessingAvailable: true,
    supportsToolCalling: true,
    supportsStructuredOutput: true,
    termsUrl: "https://www.anthropic.com/legal/commercial-terms",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    transmitsContent: true,
    zeroRetentionAvailable: true,
    regionalProcessingAvailable: true,
    supportsToolCalling: true,
    supportsStructuredOutput: true,
    termsUrl: "https://openai.com/policies/business-terms",
  },
  offline: {
    id: "offline",
    label: "Built-in engine",
    transmitsContent: false,
    zeroRetentionAvailable: false,
    regionalProcessingAvailable: false,
    supportsToolCalling: false,
    supportsStructuredOutput: true,
    termsUrl: null,
  },
};

export function providerProfile(): ProviderProfile {
  // Mirrors getProvider()'s resolution exactly, so the profile describes what
  // will actually happen rather than what was requested. A configured provider
  // with no key silently becomes the built-in engine, and a disclosure screen
  // that missed that would be telling the user the opposite of the truth.
  const configured = env.aiProvider;
  const id =
    configured === "anthropic" && env.anthropicApiKey ? "anthropic"
    : configured === "openai" && env.openaiApiKey ? "openai"
    : configured === "auto" && env.anthropicApiKey ? "anthropic"
    : configured === "auto" && env.openaiApiKey ? "openai"
    : "offline";

  const base = PROFILES[id] ?? PROFILES.offline!;
  const model =
    id === "anthropic" ? env.anthropicModel : id === "openai" ? env.openaiModel : null;

  return {
    ...base,
    model,
    enterpriseControls: env.aiEnterpriseAgreement && id !== "offline",
  };
}

/**
 * What the settings screen tells a user, in full.
 *
 * Deliberately concrete: naming the provider and the model is the difference
 * between an informed decision and a checkbox.
 */
export async function aiDisclosure(workspaceId: string): Promise<{
  provider: ProviderProfile;
  permission: AiPermission;
  dataSent: string[];
  dataNeverSent: string[];
}> {
  const [provider, permission] = await Promise.all([
    Promise.resolve(providerProfile()),
    aiPermission(workspaceId),
  ]);

  return {
    provider,
    permission,
    dataSent: permission.mayTransmitContent
      ? [
          "Record names — contacts, companies, deals, projects, opportunities",
          "Deal values, stages and expected close dates",
          "Task titles and due dates",
          "Recent activity titles from the last few weeks",
          "Note text, when a note is part of the record being summarised",
          "The question you type",
        ]
      : [],
    dataNeverSent: [
      "Passwords, session tokens and API keys",
      "Uploaded files and their contents",
      "Records from a workspace you are not a member of",
      "Audit log entries",
      "Billing details",
      ...(permission.mayTransmitContent ? [] : ["Any CRM content at all, in this mode"]),
    ],
  };
}
