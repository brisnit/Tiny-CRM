/**
 * Centralised environment access. Everything that reads `process.env` outside of
 * `next.config.ts` should come through here so a missing variable fails loudly
 * at the edge of the system rather than as `undefined` deep inside a query.
 */

function optional(key: string): string | undefined {
  const value = process.env[key];
  return value && value.length > 0 ? value : undefined;
}

function required(key: string, fallback?: string): string {
  const value = optional(key) ?? fallback;
  if (!value) {
    throw new Error(
      `Missing required environment variable ${key}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export const env = {
  databaseUrl: required("DATABASE_URL", "file:./dev.db"),
  authSecret: required(
    "AUTH_SECRET",
    // Dev-only fallback so `npm run dev` works straight after clone. Production
    // builds must supply a real secret; see assertProductionEnv() below.
    "tiny-crm-development-secret-do-not-use-in-production",
  ),
  nodeEnv: process.env.NODE_ENV ?? "development",

  /** AI provider selection. `auto` picks whichever key is present. */
  aiProvider: (optional("AI_PROVIDER") ?? "auto") as
    | "auto"
    | "anthropic"
    | "openai"
    | "offline",
  anthropicApiKey: optional("ANTHROPIC_API_KEY"),
  anthropicModel: optional("ANTHROPIC_MODEL") ?? "claude-opus-5",
  openaiApiKey: optional("OPENAI_API_KEY"),
  openaiModel: optional("OPENAI_MODEL") ?? "gpt-4o",
} as const;

export const isProduction = env.nodeEnv === "production";

/** True when the database URL points at Postgres rather than the dev SQLite file. */
export const isPostgres = /^postgres(ql)?:\/\//.test(env.databaseUrl);

export function assertProductionEnv() {
  if (!isProduction) return;
  if (!optional("AUTH_SECRET")) {
    throw new Error("AUTH_SECRET must be set in production.");
  }
}
