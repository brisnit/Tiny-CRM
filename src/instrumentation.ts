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
