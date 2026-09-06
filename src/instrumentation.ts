/**
 * Startup instrumentation.
 *
 * Next runs `register()` once, before the server accepts traffic. This is where
 * the production safety gate lives: an unsafe configuration — a published dev
 * secret, demo authentication left on, a SQLite file in production — stops the
 * process here rather than silently serving requests.
 *
 * It is also the integration point for error tracking and tracing (Sentry,
 * OpenTelemetry); the hooks are marked below.
 */
export async function register() {
  // Only the Node runtime can read the full environment or reach the database.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { assertProductionEnv, productionWarnings, env, isProduction } = await import("@/lib/env");
  const { log } = await import("@/lib/logger");

  try {
    assertProductionEnv();
  } catch (error) {
    // Printed rather than logged: the logger's own configuration may be part of
    // what is wrong, and this must be legible in a deploy log.
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    throw error;
  }

  for (const warning of productionWarnings()) {
    log.warn("configuration warning", { warning });
  }

  log.info("tiny crm starting", {
    env: env.nodeEnv,
    release: env.release,
    database: isProduction ? "postgres" : env.databaseUrl.startsWith("file:") ? "sqlite" : "postgres",
    aiProvider: env.aiProvider,
    demoAuth: env.allowDemoAuth,
  });

  // Error tracking integration point.
  //   const Sentry = await import("@sentry/nextjs");
  //   Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1, release: env.release });
}

/**
 * Next calls this for uncaught request errors. Routed through the structured
 * logger so production errors carry the request id and are redacted.
 */
export async function onRequestError(
  error: unknown,
  request: { path?: string; method?: string },
) {
  const { log } = await import("@/lib/logger");
  log.error("unhandled request error", {
    path: request.path,
    method: request.method,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}
