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
import { readFileSync } from "node:fs";

import { PLANS } from "@/lib/plans";
import {
  ConfigurationError, assertProductionEnv, assertStripeEnvironment, isProduction, productionWarnings,
} from "@/lib/env";

try {
  assertProductionEnv();
  // Runs in every environment, unlike the gate above, because the case it
  // guards is a live payment credential on a preview deployment.
  assertStripeEnvironment();
  // scripts/lib/stripe-catalogue.mjs is what the sync script creates prices from,
  // and src/lib/plans.ts is what the pricing page renders. If they drift,
  // customers are shown one number and charged another — so the comparison is a
  // check rather than a convention.
  const catalogue = readFileSync(
    new URL("./lib/stripe-catalogue.mjs", import.meta.url),
    "utf8",
  );
  for (const plan of ["plus", "pro"] as const) {
    const match = new RegExp(`plan: "${plan}"[\\s\\S]*?amountCents: (\\d+)`).exec(catalogue);
    if (!match) throw new ConfigurationError([`stripe-catalogue.mjs has no amount for ${plan}.`]);
    const scripted = Number(match[1]);
    const declared = PLANS[plan].priceCents;
    if (scripted !== declared) {
      throw new ConfigurationError([
        `Stripe catalogue and plans.ts disagree on ${plan}: the catalogue declares a price of ` +
          `${scripted} cents, the application advertises ${declared}. One of them is wrong.`,
      ]);
    }
  }

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
