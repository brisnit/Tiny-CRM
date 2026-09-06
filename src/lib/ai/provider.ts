import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import { env } from "@/lib/env";

/**
 * Model-provider abstraction.
 *
 * Nothing above this file knows which vendor answers a request. Callers ask for
 * text or JSON; the provider is chosen from configuration at call time. Adding a
 * provider means implementing `AiProvider` and registering it below — no change
 * to prompts, summaries or the agent.
 *
 * The `offline` provider is not a stub: it is a deterministic reasoning engine
 * (src/lib/ai/offline.ts) built on the scoring functions in src/lib/scoring.ts,
 * so an install with no API key still produces true, explainable insights
 * instead of blank panels.
 */

export type AiMessage = { role: "user" | "assistant"; content: string };

export type CompleteOptions = {
  system: string;
  messages: AiMessage[];
  maxTokens?: number;
  /** Depth/cost dial, passed through to providers that support it. */
  effort?: "low" | "medium" | "high";
  /** When set, the model is asked to return JSON matching this shape. */
  jsonSchema?: Record<string, unknown>;
  /** Identifies the caller in logs and usage accounting. */
  purpose: string;
};

export type CompleteResult = {
  text: string;
  model: string;
  provider: ProviderId;
  inputTokens?: number;
  outputTokens?: number;
};

export type ProviderId = "anthropic" | "openai" | "offline";

export interface AiProvider {
  readonly id: ProviderId;
  readonly model: string;
  complete(options: CompleteOptions): Promise<CompleteResult>;
  stream(options: CompleteOptions): AsyncIterable<string>;
}

// --- Anthropic -------------------------------------------------------------

class AnthropicProvider implements AiProvider {
  readonly id = "anthropic" as const;
  readonly model = env.anthropicModel;
  private client = new Anthropic({ apiKey: env.anthropicApiKey });

  async complete(options: CompleteOptions): Promise<CompleteResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: options.maxTokens ?? 2048,
      system: options.system,
      // Adaptive thinking lets the model decide how much reasoning a given CRM
      // question needs; effort keeps routine summaries cheap.
      thinking: { type: "adaptive" },
      output_config: { effort: options.effort ?? "low" },
      messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    return {
      text,
      model: response.model,
      provider: this.id,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }

  async *stream(options: CompleteOptions): AsyncIterable<string> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: options.maxTokens ?? 4096,
      system: options.system,
      thinking: { type: "adaptive" },
      output_config: { effort: options.effort ?? "low" },
      messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text;
      }
    }
  }
}

// --- OpenAI ----------------------------------------------------------------

class OpenAiProvider implements AiProvider {
  readonly id = "openai" as const;
  readonly model = env.openaiModel;
  private client = new OpenAI({ apiKey: env.openaiApiKey });

  async complete(options: CompleteOptions): Promise<CompleteResult> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: options.maxTokens ?? 2048,
      messages: [
        { role: "system", content: options.system },
        ...options.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      ...(options.jsonSchema ? { response_format: { type: "json_object" as const } } : {}),
    });

    return {
      text: response.choices[0]?.message?.content?.trim() ?? "",
      model: response.model,
      provider: this.id,
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    };
  }

  async *stream(options: CompleteOptions): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
      messages: [
        { role: "system", content: options.system },
        ...options.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
}

// --- Selection -------------------------------------------------------------

let cached: AiProvider | null = null;

export function getProvider(): AiProvider {
  if (cached) return cached;

  const configured = env.aiProvider;
  if (configured === "anthropic" && env.anthropicApiKey) cached = new AnthropicProvider();
  else if (configured === "openai" && env.openaiApiKey) cached = new OpenAiProvider();
  else if (configured === "auto" && env.anthropicApiKey) cached = new AnthropicProvider();
  else if (configured === "auto" && env.openaiApiKey) cached = new OpenAiProvider();
  else cached = null;

  if (!cached) {
    // Resolved lazily to avoid a cycle: offline.ts imports these types.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OfflineProvider } = require("@/lib/ai/offline") as typeof import("@/lib/ai/offline");
    cached = new OfflineProvider();
  }
  return cached;
}

/** True when a real model is configured. The UI says so rather than pretending. */
export function isModelBacked() {
  return getProvider().id !== "offline";
}

export function describeProvider() {
  const provider = getProvider();
  return {
    id: provider.id,
    model: provider.model,
    label:
      provider.id === "anthropic"
        ? `Claude (${provider.model})`
        : provider.id === "openai"
          ? `OpenAI (${provider.model})`
          : "Built-in reasoning engine",
  };
}

/** Reset between tests or after configuration changes. */
export function resetProvider() {
  cached = null;
}

/**
 * The provider to use for one workspace, honouring its AI privacy mode.
 *
 * A workspace set to `disabled` — or to `private` without an enterprise
 * agreement — gets the deterministic engine rather than an error. That is the
 * design: turning AI off must degrade the product, not break it. Scoring,
 * momentum, stall detection, the cleanup scan and the daily brief all keep
 * working, because none of them ever needed a model.
 *
 * Every call site that sends CRM content to a provider uses this rather than
 * `getProvider()`, so the mode cannot be bypassed by forgetting a check.
 */
export async function getProviderForWorkspace(workspaceId: string): Promise<AiProvider> {
  const { aiPermission } = await import("@/lib/ai/privacy");
  const permission = await aiPermission(workspaceId);

  if (permission.mayTransmitContent) return getProvider();

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { OfflineProvider } = require("@/lib/ai/offline") as typeof import("@/lib/ai/offline");
  return new OfflineProvider();
}
