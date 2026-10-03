/**
 * Startup instrumentation.
 *
 * Next runs `register()` once, before the server accepts traffic. This is where
 * the production safety gate lives: an unsafe configuration — a published dev
 * secret, demo authentication left on, a SQLite file in production — stops the
 * process here rather than silently serving requests.
 *
 * It is also where observability is wired up and where the second layer of
 * tenant isolation reports whether it is actually protecting this connection.
 */
export async function register() {
  // Only the Node runtime can read the full environment or reach the database.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const {
    assertProductionEnv, assertStripeEnvironment, productionWarnings, env, isProduction, stripeMode,
  } = await import("@/lib/env");
  const { log } = await import("@/lib/logger");

  try {
    assertProductionEnv();
    // Runs in every environment, unlike the gate above. The case it guards is a
    // live payment credential on a preview deployment.
    assertStripeEnvironment();
  } catch (error) {
    // Printed rather than logged: the logger's own configuration may be part of
    // what is wrong, and this must be legible in a deploy log.
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    throw error;
  }

  for (const warning of productionWarnings()) {
    log.warn("configuration warning", { warning });
  }

  // The pricing cutover grandfather is deliberately temporary: it raises Free's
  // AI allowance back to its pre-release figure for one usage period, so a
  // mid-month release cannot refuse an account for requests it made under the
  // old published ceiling. Being temporary, it must not rot unnoticed — a
  // constant that no longer matches the calendar is reported here rather than
  // discovered later from a support question.
  {
    const { PRICING_CUTOVER_PERIOD, PRE_STRIPE_FREE_AI_ALLOWANCE, PLANS } =
      await import("@/lib/plans");
    const { currentPeriod } = await import("@/lib/dates");
    const now = currentPeriod();
    if (PRICING_CUTOVER_PERIOD !== null && PRICING_CUTOVER_PERIOD < now) {
      log.warn("configuration warning", {
        warning:
          `PRICING_CUTOVER_PERIOD is ${PRICING_CUTOVER_PERIOD}, before the current period ` +
          `${now}. The Free AI grandfather has expired on its own and affects nothing; ` +
          `the constant can be deleted.`,
      });
    } else if (PRICING_CUTOVER_PERIOD !== null && PRICING_CUTOVER_PERIOD > now) {
      log.warn("configuration warning", {
        warning:
          `PRICING_CUTOVER_PERIOD is ${PRICING_CUTOVER_PERIOD}, a future period. Free ` +
          `accounts are on the new allowance of ${PLANS.free.limits.aiRequestsPerMonth} ` +
          `now, not ${PRE_STRIPE_FREE_AI_ALLOWANCE}. If the release ships this month, ` +
          `set it to ${now}.`,
      });
    }
  }

  log.info("tiny crm starting", {
    env: env.nodeEnv,
    release: env.release,
    database: isProduction ? "postgres" : env.databaseUrl.startsWith("file:") ? "sqlite" : "postgres",
    aiProvider: env.aiProvider,
    demoAuth: env.allowDemoAuth,
    /**
     * Whether a usable Anthropic credential reached this runtime.
     *
     * Kept after the diagnostic it began as, because it answered a question that
     * cost a release to ask: production manifested ANTHROPIC_API_KEY but
     * delivered an empty value, so the provider resolved to the built-in engine
     * and a document answer arrived with correct citations and wrong content.
     * One boolean on the boot line is what distinguishes "no key configured"
     * from "key configured but blank" without another deploy.
     *
     * Reveals nothing recoverable: not the value, a prefix, a suffix, a length, a
     * hash or a character class. The field name deliberately avoids "key" and
     * "apiKey" because `redact()` in src/lib/logger.ts scrubs
     * /api[-_]?key/i and would replace it with "[redacted]".
     */
    anthropicUsable: (process.env.ANTHROPIC_API_KEY ?? "").trim().length > 0,
    /**
     * Which Stripe mode this deployment can transact in: "test", "live", or null
     * when billing is not configured. Derived from the key prefix, never from a
     * separate variable that could disagree with it.
     */
    stripe: stripeMode() ?? "unconfigured",
    /**
     * Which usage period, if any, still enforces the pre-release Free AI
     * allowance. "off" once the grandfather is gone, which is the steady state.
     */
    aiCutover: (await import("@/lib/plans")).PRICING_CUTOVER_PERIOD ?? "off",
  });

  const { reportObservabilityStatus } = await import("@/lib/observability");
  reportObservabilityStatus();

  // Row-level security is the second isolation layer, and it is silently absent
  // when the connection is a superuser or the policies were never applied. This
  // asks the database rather than assuming, and says so at error level when the
  // answer is no. It warns rather than throws: a missing second layer must not
  // take down a deployment whose first layer is intact.
  const { reportRlsStatus } = await import("@/lib/tenant-db");
  await reportRlsStatus();

  const { rateLimitBackend } = await import("@/lib/rate-limit");
  const limiter = rateLimitBackend();
  log.info("rate limiting", { backend: limiter.kind, distributed: limiter.distributed });
}

/**
 * Next calls this for uncaught request errors. Routed through the structured
 * logger so production errors carry the request id and are redacted.
 */
export async function onRequestError(
  error: unknown,
  request: { path?: string; method?: string },
  context?: { routePath?: string; routeType?: string },
) {
  const { log } = await import("@/lib/logger");
  log.error("unhandled request error", {
    path: request.path,
    method: request.method,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  // And to the configured error tracker, with a payload built from an explicit
  // allowlist — see src/lib/observability.ts for why that matters here.
  //
  // `context.routePath` is the route *file* path (`/contacts/[id]`), not the
  // requested URL: no record ids, no query string, and it groups every instance
  // of one fault into a single issue instead of one per record. `request.path`
  // is the fallback, and the sink strips its query string — Next documents that
  // path as including one, which for /api/search means the user's search term.
  const { captureError } = await import("@/lib/observability");
  await captureError(error, {
    route: context?.routePath ?? request.path,
    operation: request.method,
    tags: context?.routeType ? { routeType: context.routeType } : undefined,
  });
}
