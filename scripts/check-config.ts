/**
 * Production configuration gate, as a standalone command.
 *
 * The same check runs at server startup (src/instrumentation.ts). Exposing it as
 * a command lets a deploy pipeline fail *before* traffic is routed, rather than
 * after the first request finds a crash-looping process.
 *
 *   NODE_ENV=production tsx scripts/check-config.ts
 *
 * Exit codes: 0 safe, 1 unsafe (problems printed), 2 unexpected failure.
 */
import { ConfigurationError, assertProductionEnv, isProduction, productionWarnings } from "@/lib/env";

try {
  assertProductionEnv();
  const warnings = productionWarnings();
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  console.log(
    isProduction
      ? `Production configuration is safe${warnings.length ? ` (${warnings.length} warning(s))` : ""}.`
      : "Not a production environment — the production gate did not run.",
  );
  process.exit(0);
} catch (error) {
  if (error instanceof ConfigurationError) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(error);
  process.exit(2);
}
