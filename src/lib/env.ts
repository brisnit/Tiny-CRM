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
  /** Outbound email. Without a provider, no reset or verification can be sent. */
  mailAdapter: (optional("MAIL_ADAPTER") ?? "auto") as "auto" | "sink" | "log",
  mailProviderUrl: optional("MAIL_PROVIDER_URL"),
  mailProviderToken: optional("MAIL_PROVIDER_TOKEN"),
  mailFrom: optional("MAIL_FROM") ?? "Tiny CRM <no-reply@localhost>",

  /** Security alerting. Without a webhook, alerts are recorded and logged only. */
  alertWebhookUrl: optional("ALERT_WEBHOOK_URL"),
  alertMinSeverity: (optional("ALERT_MIN_SEVERITY") ?? "warning") as
    | "info" | "warning" | "critical",

  /** Observability. Adapters are provider-independent; see src/lib/observability.ts. */
  sentryDsn: optional("SENTRY_DSN"),
  otelEndpoint: optional("OTEL_EXPORTER_OTLP_ENDPOINT"),
  logDrainUrl: optional("LOG_DRAIN_URL"),

  demoEmail: optional("DEMO_EMAIL") ?? "owner@tinycrm.app",
  demoPassword: optional("DEMO_PASSWORD") ?? "tinycrm",

  aiProvider: (optional("AI_PROVIDER") ?? "auto") as "auto" | "anthropic" | "openai" | "offline",
  anthropicApiKey: optional("ANTHROPIC_API_KEY"),
  anthropicModel: optional("ANTHROPIC_MODEL") ?? "claude-opus-5",
  openaiApiKey: optional("OPENAI_API_KEY"),
  openaiModel: optional("OPENAI_MODEL") ?? "gpt-4o",

  /**
   * Asserts that this deployment holds an enterprise or zero-retention
   * agreement with its model provider.
   *
   * Never inferred. A provider offering such an arrangement says nothing about
   * whether *this account* has one, and the "private model only" workspace mode
   * fails closed until an operator states that it does.
   */
  aiEnterpriseAgreement: flag("AI_ENTERPRISE_AGREEMENT", false),

  /** Shared secret a billing provider signs its webhooks with. */
  billingWebhookSecret: optional("BILLING_WEBHOOK_SECRET"),

  /**
   * Stripe. Server-side only — every one of these is read here and never
   * forwarded to the browser. Hosted Checkout and the Customer Portal are both
   * server-created redirects, so there is no publishable key and no client SDK:
   * nothing Stripe-related is in the bundle, which
   * tests/security/client-bundle.test.ts asserts.
   *
   * The mode is not configured; it is *derived* from the key prefix by
   * `stripeMode` below. A separate STRIPE_MODE variable could disagree with the
   * key, and the failure mode of that disagreement is charging a real card while
   * believing you are in test mode.
   */
  stripeSecretKey: optional("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: optional("STRIPE_WEBHOOK_SECRET"),
  /** Recurring monthly price ids. Not secret, but environment-specific. */
  stripePricePlus: optional("STRIPE_PRICE_PLUS"),
  stripePricePro: optional("STRIPE_PRICE_PRO"),

  /**
   * Which Vercel environment this is: production, preview or development.
   * Supplied by the platform. Needed because "is this production" and "may this
   * hold live payment credentials" are different questions — a preview
   * deployment is not production and must never be able to charge a card.
   */
  vercelEnv: optional("VERCEL_ENV"),

  // Shared secret for /api/cron/jobs. On a platform with no long-lived process
  // this endpoint *is* the worker, so an unset value means the outbox silently
  // stops draining — see the production warning below.
  cronSecret: optional("CRON_SECRET"),

  /** Optional Redis-compatible rate-limit backend. Falls back to in-memory. */
  /**
   * Rate limiting. `auto` picks Redis when a URL is configured, otherwise
   * memory. Production refuses to boot on memory when APP_INSTANCES > 1.
   */
  rateLimitBackend: (optional("RATE_LIMIT_BACKEND") ?? "auto") as
    | "auto" | "memory" | "redis" | "postgres",
  rateLimitRedisUrl: optional("RATE_LIMIT_REDIS_URL"),
  rateLimitRedisToken: optional("RATE_LIMIT_REDIS_TOKEN"),
  rateLimitUsePostgres: flag("RATE_LIMIT_USE_POSTGRES", false),

  /**
   * How many application instances this deployment runs. Declared rather than
   * detected: a process cannot see its siblings, and the difference between
   * "one instance" and "several" is exactly what decides whether an in-process
   * rate limiter is a control or a decoration.
   */
  appInstances: Number(optional("APP_INSTANCES") ?? "1"),

  /**
   * Object storage for file uploads. Absent means uploads stay disabled.
   *
   * `local` and `s3` are the *same* driver, differing only in where it points.
   * There is deliberately no filesystem implementation: a second driver would
   * be a second thing to keep correct, and the one property worth proving
   * locally — that SigV4 presigning, CORS, ranged reads and deletes behave the
   * way production behaves — is exactly the property a filesystem stub cannot
   * demonstrate. `local` is Garage on a developer's machine, speaking the same
   * protocol R2 speaks in production.
   */
  storageDriver: (optional("STORAGE_DRIVER") ?? "none") as "none" | "local" | "s3",
  storageBucket: optional("STORAGE_BUCKET"),
  /** Full origin of the S3-compatible endpoint, e.g. https://<account>.r2.cloudflarestorage.com */
  storageEndpoint: optional("S3_ENDPOINT"),
  /** R2 ignores the region but SigV4 still signs one; `auto` is what R2 documents. */
  storageRegion: optional("S3_REGION") ?? "auto",
  storageAccessKeyId: optional("S3_ACCESS_KEY_ID"),
  storageSecretAccessKey: optional("S3_SECRET_ACCESS_KEY"),

  logLevel: (optional("LOG_LEVEL") ?? (isProduction ? "info" : "debug")) as
    | "debug" | "info" | "warn" | "error",

  /** Opt-in, development-only: include AI prompt text in logs. */
  logAiPrompts: flag("LOG_AI_PROMPTS", false),

  release: optional("VERCEL_GIT_COMMIT_SHA") ?? optional("APP_RELEASE") ?? "dev",
} as const;

export const isPostgres = /^postgres(ql)?:\/\//.test(env.databaseUrl);

/**
 * Which Stripe mode the configured key belongs to, read from the key itself.
 *
 * `null` means no key is configured, which is a valid state: billing is simply
 * unavailable and the UI says so rather than offering a checkout that cannot
 * complete.
 */
export function stripeMode(): "test" | "live" | null {
  const key = env.stripeSecretKey;
  if (!key) return null;
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  // An unrecognised prefix is treated as live. Guessing "test" here would be
  // the dangerous direction: it would permit the key in a preview deployment.
  return "live";
}

/** True when a real card can be charged with the current configuration. */
export function stripeIsLive(): boolean {
  return stripeMode() === "live";
}

/** True when checkout and the portal can actually be used. */
export function stripeConfigured(): boolean {
  return Boolean(env.stripeSecretKey && env.stripeWebhookSecret);
}

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

  // The migration credential must not exist in the application's environment.
  // It is the owner/admin role: it can drop tables, rewrite the audit log, and
  // — because FORCE ROW LEVEL SECURITY does not bind a superuser — read every
  // tenant's data with the policies fully in place. Migrations are run by an
  // operator from their own machine, deliberately, with these credentials
  // supplied there and nowhere else.
  if (optional("DIRECT_URL")) {
    problems.push(
      "DIRECT_URL is set. That is the unpooled migration credential and belongs " +
        "only on the machine running migrations — never in the application's " +
        "environment. Remove it from this deployment.",
    );
  }

  // A best-effort check on the runtime role. This cannot catch every misuse —
  // an owner role can be named anything — so it is a cheap guard, not the
  // control. The control is rlsStatus(), which asks the database itself and is
  // reported at boot by src/instrumentation.ts.
  const runtimeUser = /^postgres(ql)?:\/\/([^:@/]+)/.exec(env.databaseUrl)?.[2];
  if (runtimeUser && ["postgres", "root", "admin", "superuser"].includes(runtimeUser.toLowerCase())) {
    problems.push(
      `DATABASE_URL connects as "${runtimeUser}", which is an administrative role. ` +
        "The application must connect as an unprivileged role (tinycrm_app): a " +
        "superuser bypasses FORCE ROW LEVEL SECURITY entirely, so tenant isolation " +
        "would rest on the application layer alone. See docs/VERCEL-DEPLOYMENT.md.",
    );
  }

  // These three are unchanged and remain fatal: an unset, localhost or plaintext
  // APP_URL in production is a deployment that should not serve traffic.
  //
  // A *deployment hostname* is deliberately NOT fatal — see productionWarnings.
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

  // A live Stripe key charges real cards. A preview deployment is built from an
  // arbitrary branch, is reachable by anyone with the URL, and exists to try
  // changes out — the one place a payment credential must never be. This is
  // fatal rather than a warning because the damage is somebody's money, and
  // because the correct configuration (test keys in Preview) is no harder to
  // set up than the wrong one.
  //
  // Note this is checked under isProduction only because assertProductionEnv
  // returns early otherwise; `assertStripeEnvironment` below is what runs for
  // preview builds, and src/instrumentation.ts calls both.
  if (env.stripeSecretKey && !env.stripeWebhookSecret) {
    problems.push(
      "STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not. Without the signing " +
        "secret no subscription event can be verified, so a paid plan could never be " +
        "granted — and an unverified endpoint must not be trusted to grant one.",
    );
  }

  if (env.stripeSecretKey && stripeIsLive()) {
    if (!env.stripePricePlus || !env.stripePricePro) {
      problems.push(
        "A live Stripe key is configured but STRIPE_PRICE_PLUS or STRIPE_PRICE_PRO is " +
          "missing. Live billing with an unresolvable price fails at checkout, after the " +
          "customer has committed.",
      );
    }
  }

  if (env.storageDriver === "s3" && !env.storageBucket) {
    problems.push("STORAGE_DRIVER=s3 but STORAGE_BUCKET is not set.");
  }

  // A half-configured object store fails at the first upload rather than at
  // boot, which is the wrong end of the deployment to discover it.
  if (env.storageDriver !== "none") {
    for (const [key, value] of [
      ["S3_ENDPOINT", env.storageEndpoint],
      ["S3_ACCESS_KEY_ID", env.storageAccessKeyId],
      ["S3_SECRET_ACCESS_KEY", env.storageSecretAccessKey],
      ["STORAGE_BUCKET", env.storageBucket],
    ] as const) {
      if (!value) problems.push(`STORAGE_DRIVER=${env.storageDriver} but ${key} is not set.`);
    }
  }

  // A deployment that declares it scans uploads must actually be able to. This
  // is a hard problem rather than a warning because the alternative is the
  // failure the whole seam exists to prevent: believing scanning is on while
  // every upload goes through unscanned. `scanForMalware` also refuses at
  // request time, but discovering it there means the first customer upload is
  // the test.
  if (process.env["REQUIRE_MALWARE_SCAN"] === "true" && !process.env["MALWARE_SCANNER_URL"]?.trim()) {
    problems.push(
      "REQUIRE_MALWARE_SCAN=true but MALWARE_SCANNER_URL is not set. Point it at a " +
        "scanner, or unset REQUIRE_MALWARE_SCAN to accept unscanned uploads.",
    );
  }

  // Rate limiting is only a control if the counters are shared. On more than one
  // instance an in-process limiter gives an attacker N times every limit, and
  // resets them all on each deploy — so a deployment that declares more than one
  // instance must configure a shared store rather than silently fall back.
  const usingSharedStore = usingSharedRateLimitStore();

  if (!Number.isFinite(env.appInstances) || env.appInstances < 1) {
    problems.push("APP_INSTANCES must be a positive whole number.");
  } else if (env.appInstances > 1 && !usingSharedStore) {
    problems.push(
      `APP_INSTANCES is ${env.appInstances} but rate limiting is in-process. ` +
        "Set RATE_LIMIT_REDIS_URL, or RATE_LIMIT_BACKEND=postgres to share counters " +
        "through the database.",
    );
  }

  if (env.rateLimitBackend === "redis" && !env.rateLimitRedisUrl) {
    problems.push("RATE_LIMIT_BACKEND=redis but RATE_LIMIT_REDIS_URL is not set.");
  }
  if (env.rateLimitBackend === "postgres" && env.databaseUrl.startsWith("file:")) {
    problems.push("RATE_LIMIT_BACKEND=postgres but DATABASE_URL is not PostgreSQL.");
  }

  if (problems.length > 0) throw new ConfigurationError(problems);
}

/**
 * Whether rate-limit counters are shared between instances.
 *
 * Exported so the startup gate, the startup warnings and the readiness endpoint
 * all answer this the same way, rather than each re-deriving it.
 */
export function usingSharedRateLimitStore(): boolean {
  return (
    env.rateLimitBackend === "redis" ||
    env.rateLimitBackend === "postgres" ||
    env.rateLimitUsePostgres ||
    (env.rateLimitBackend === "auto" && Boolean(env.rateLimitRedisUrl))
  );
}

/** Non-fatal configuration observations, surfaced at startup. */
/**
 * Refuses to start any deployment holding payment credentials it must not hold.
 *
 * Separate from `assertProductionEnv` because that function returns early
 * outside production, and the case this guards is specifically a **preview**
 * deployment. Called from src/instrumentation.ts for every environment.
 */
export function assertStripeEnvironment(): void {
  const problems: string[] = [];

  if (env.vercelEnv === "preview" && stripeIsLive()) {
    problems.push(
      "A live Stripe key is configured on a PREVIEW deployment. Preview builds come " +
        "from arbitrary branches and must never be able to charge a real card. Scope " +
        "the live key to Production only, and give Preview a test-mode key.",
    );
  }

  if (problems.length > 0) throw new ConfigurationError(problems);
}

export function productionWarnings(): string[] {
  const warnings: string[] = [];

  // APP_URL is what customer-facing links are built from, and "is it HTTPS and
  // not localhost" was too weak a test: a *.vercel.app deployment hostname
  // passes both, and one did — going out in real password-reset email. A link
  // on a deployment hostname works until that deployment is superseded, and
  // then the person locked out of their account clicks a 404.
  //
  // A warning, not a boot failure. The first version of this check was fatal
  // and took production down the moment it shipped, to correct a value that
  // appOrigin() already compensates for — it falls back to the canonical
  // domain, so the links are right either way. Refusing to serve traffic over
  // a value that is no longer load-bearing is not failing safely; it is
  // failing loudly at the customer's expense.
  if (isProduction && optional("APP_URL")) {
    try {
      if (/(^|\.)vercel\.app$/i.test(new URL(env.appUrl).hostname)) {
        warnings.push(
          `APP_URL is a deployment hostname (${env.appUrl}). Customer-facing links are using the ` +
            "canonical origin instead. Set APP_URL to the canonical domain.",
        );
      }
    } catch {
      warnings.push(`APP_URL is not a parseable URL (${env.appUrl}).`);
    }
  }

  if (isProduction) {
    if (!env.billingWebhookSecret) {
      warnings.push("BILLING_WEBHOOK_SECRET is not set — plan changes cannot be applied by a provider.");
    }
    if (!env.mailProviderUrl || !env.mailProviderToken) {
      warnings.push(
        "No mail provider is configured — password reset and email verification " +
          "cannot deliver. Set MAIL_PROVIDER_URL and MAIL_PROVIDER_TOKEN.",
      );
    }

    if (!env.cronSecret) {
      warnings.push(
        "CRON_SECRET is not set — /api/cron/jobs will refuse to run. On a platform " +
          "with no long-lived process this is the only job runner, so automations, " +
          "scheduled workspace deletions and retention sweeps will not happen. " +
          "Either set it and schedule the endpoint, or run `npm run worker`.",
      );
    }

    if (env.storageDriver !== "none" && !process.env["MALWARE_SCANNER_URL"]?.trim()) {
      warnings.push(
        "Object storage is configured but MALWARE_SCANNER_URL is not — uploads are " +
          "accepted without being scanned. Set MALWARE_SCANNER_URL, and " +
          "REQUIRE_MALWARE_SCAN=true to refuse uploads when the scanner cannot answer.",
      );
    }

    if (!usingSharedRateLimitStore()) {
      warnings.push(
        "Rate limiting is in-process — counters are per-instance and reset on deploy.",
      );
    }
    if (env.logAiPrompts) {
      warnings.push("LOG_AI_PROMPTS is enabled — AI prompt text will be written to logs.");
    }
  }
  return warnings;
}
