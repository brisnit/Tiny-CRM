/**
 * Environment access and production safety gate.
 *
 * Everything that reads `process.env` outside `next.config.ts` comes through
 * here, so a missing or unsafe value fails loudly at the edge of the system
 * rather than as `undefined` deep inside a query — or, worse, as a silently
 * insecure default.
 *
 * `assertProductionEnv()` is called from src/instrumentation.ts, which Next runs
 * before the server accepts traffic. An unsafe production configuration stops
 * the process instead of serving requests.
 */

/**
 * The development session secret. Exported so the production gate, the tests and
 * the deployment checklist all name the same value rather than three copies of
 * a string that must never diverge.
 */
export const DEV_AUTH_SECRET = "tiny-crm-development-only-secret-never-use-in-production";

function optional(key: string): string | undefined {
  const value = process.env[key];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

export const NODE_ENV = process.env.NODE_ENV ?? "development";
export const isProduction = NODE_ENV === "production";
export const isTest = NODE_ENV === "test";
export const isDevelopment = !isProduction && !isTest;

function required(key: string, devFallback?: string): string {
  const value = optional(key);
  if (value) return value;

  // A fallback is a development convenience only; it is never substituted in
  // production.
  if (devFallback !== undefined && !isProduction) return devFallback;

  // In production, resolve to an empty string rather than throwing here.
  // Throwing at import time reports only the *first* missing variable, so an
  // operator fixes one, redeploys, and discovers the next — one incident per
  // variable. assertProductionEnv() checks every required key and reports them
  // together; every key that uses this fallback is covered there.
  if (isProduction) return "";

  throw new Error(
    `Missing required environment variable ${key}. Copy .env.example to .env and fill it in.`,
  );
}

function flag(key: string, fallback = false): boolean {
  const value = optional(key)?.toLowerCase();
  if (value === undefined) return fallback;
  return value === "1" || value === "true" || value === "yes";
}

export const env = {
  nodeEnv: NODE_ENV,
  databaseUrl: required("DATABASE_URL", "file:./dev.db"),
  authSecret: required("AUTH_SECRET", DEV_AUTH_SECRET),

  /** Canonical origin. Used for cookies, redirects and absolute links. */
  appUrl: optional("APP_URL") ?? optional("NEXT_PUBLIC_SITE_URL") ?? "http://localhost:3000",

  /**
   * Enables the seeded demo account shortcut on the sign-in screen. Refused in
   * production by assertProductionEnv() — see docs/SECURITY.md.
   */
  allowDemoAuth: flag("ALLOW_DEMO_AUTH", !isProduction),

  /**
   * Credentials for the "open the demo workspace" button. Read here, on the
   * server, so they are never a literal inside a client component and therefore
   * never compiled into the browser bundle.
   */
  demoEmail: optional("DEMO_EMAIL") ?? "owner@tinycrm.app",
  demoPassword: optional("DEMO_PASSWORD") ?? "tinycrm",

  aiProvider: (optional("AI_PROVIDER") ?? "auto") as "auto" | "anthropic" | "openai" | "offline",
  anthropicApiKey: optional("ANTHROPIC_API_KEY"),
  anthropicModel: optional("ANTHROPIC_MODEL") ?? "claude-opus-5",
  openaiApiKey: optional("OPENAI_API_KEY"),
  openaiModel: optional("OPENAI_MODEL") ?? "gpt-4o",

  /** Shared secret a billing provider signs its webhooks with. */
  billingWebhookSecret: optional("BILLING_WEBHOOK_SECRET"),

  /** Optional Redis-compatible rate-limit backend. Falls back to in-memory. */
  rateLimitRedisUrl: optional("RATE_LIMIT_REDIS_URL"),

  /** Object storage for file uploads. Absent means uploads stay disabled. */
  storageDriver: (optional("STORAGE_DRIVER") ?? "none") as "none" | "local" | "s3",
  storageBucket: optional("STORAGE_BUCKET"),

  logLevel: (optional("LOG_LEVEL") ?? (isProduction ? "info" : "debug")) as
    | "debug" | "info" | "warn" | "error",

  /** Opt-in, development-only: include AI prompt text in logs. */
  logAiPrompts: flag("LOG_AI_PROMPTS", false),

  release: optional("VERCEL_GIT_COMMIT_SHA") ?? optional("APP_RELEASE") ?? "dev",
} as const;

export const isPostgres = /^postgres(ql)?:\/\//.test(env.databaseUrl);

export class ConfigurationError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `Refusing to start: unsafe production configuration.\n\n${problems
        .map((p, i) => `  ${i + 1}. ${p}`)
        .join("\n")}\n\nSee docs/DEPLOYMENT-CHECKLIST.md.`,
    );
    this.name = "ConfigurationError";
  }
}

/**
 * Refuses to start a production server that is configured unsafely. This is the
 * single gate that prevents development conveniences — the demo login, the
 * published dev secret, a local SQLite file — from reaching real users.
 */
export function assertProductionEnv(): void {
  if (!isProduction) return;
  const problems: string[] = [];

  if (!optional("AUTH_SECRET")) {
    problems.push("AUTH_SECRET is not set. Generate one with: openssl rand -base64 32");
  } else if (env.authSecret === DEV_AUTH_SECRET) {
    problems.push("AUTH_SECRET is the published development value. Generate a real secret.");
  } else if (env.authSecret.length < 32) {
    problems.push("AUTH_SECRET is shorter than 32 characters.");
  }

  if (env.allowDemoAuth || optional("ALLOW_DEMO_AUTH")) {
    problems.push(
      "ALLOW_DEMO_AUTH is enabled. Demo authentication must never be reachable in production.",
    );
  }

  if (!optional("DATABASE_URL")) {
    problems.push("DATABASE_URL is not set.");
  } else if (env.databaseUrl.startsWith("file:")) {
    problems.push(
      "DATABASE_URL points at a local SQLite file. Production must use PostgreSQL — see npm run db:use-postgres.",
    );
  }

  if (!optional("APP_URL")) {
    problems.push("APP_URL is not set.");
  } else if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(env.appUrl)) {
    problems.push(`APP_URL points at localhost (${env.appUrl}).`);
  } else if (!env.appUrl.startsWith("https://")) {
    problems.push(`APP_URL must use HTTPS in production (got ${env.appUrl}).`);
  }

  if (optional("SEED_ALLOW_PRODUCTION")) {
    problems.push("SEED_ALLOW_PRODUCTION is set. Demo data must never be seeded in production.");
  }

  if (process.env.TINYCRM_TEST_IDENTITY) {
    problems.push("TINYCRM_TEST_IDENTITY is set. The test identity hook must never be enabled outside tests.");
  }

  if (env.storageDriver === "s3" && !env.storageBucket) {
    problems.push("STORAGE_DRIVER=s3 but STORAGE_BUCKET is not set.");
  }

  if (problems.length > 0) throw new ConfigurationError(problems);
}

/** Non-fatal configuration observations, surfaced at startup. */
export function productionWarnings(): string[] {
  const warnings: string[] = [];
  if (isProduction) {
    if (!env.billingWebhookSecret) {
      warnings.push("BILLING_WEBHOOK_SECRET is not set — plan changes cannot be applied by a provider.");
    }
    if (!env.rateLimitRedisUrl) {
      warnings.push(
        "RATE_LIMIT_REDIS_URL is not set — rate limiting is per-instance and resets on deploy.",
      );
    }
    if (env.logAiPrompts) {
      warnings.push("LOG_AI_PROMPTS is enabled — AI prompt text will be written to logs.");
    }
  }
  return warnings;
}
