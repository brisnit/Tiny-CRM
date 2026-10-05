#!/usr/bin/env node
/**
 * Read-only inspection of the Customer Portal configuration.
 *
 * Written because `stripe-configure-portal.mjs` reported "switchable prices:
 * none" after a live run that otherwise succeeded. That line is produced by a
 * formatter in our own script, so it is not evidence about Stripe's state — it is
 * evidence about one expression. This prints the raw API response instead, so the
 * question "are both products and their prices actually configured" is answered by
 * Stripe rather than by our rendering of it.
 *
 * **Changes nothing.** It issues `list` and `retrieve` only. There is no write
 * path in this file, and no `--live` guard is needed for that reason.
 *
 *   node scripts/stripe-inspect-portal.mjs [bpc_...]
 *
 * With no argument it inspects every configuration in the account. With an id it
 * inspects that one and still lists the others, because which configuration is
 * `is_default` decides which one customers actually get.
 */
import Stripe from "stripe";

import { promptHidden } from "./lib/prompt-hidden.mjs";
import { CATALOGUE } from "./lib/stripe-catalogue.mjs";

function modeOf(key) {
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  return "unknown";
}

async function main() {
  const wanted = process.argv.slice(2).find((a) => a.startsWith("bpc_"));

  const key = await promptHidden("Stripe secret key (input hidden): ");
  const mode = modeOf(key);
  if (mode === "unknown") {
    throw new Error("That does not look like a Stripe secret key (expected sk_test_… or sk_live_…).");
  }

  const stripe = new Stripe(key, { apiVersion: "2026-09-30.endive", maxNetworkRetries: 1 });

  const account = await stripe.accounts.retrieve();
  console.log(`\nStripe account: ${account.settings?.dashboard?.display_name ?? account.id}`);
  console.log(`Mode: ${mode.toUpperCase()}  (read-only — nothing is written)\n`);

  // Every configuration, because a correct configuration that is not the default
  // is not the one customers see. `createPortalSession` in src/lib/billing/stripe.ts
  // does not pin a configuration id, so Stripe uses the account default.
  const all = await stripe.billingPortal.configurations.list({ limit: 100 });
  console.log(`portal configurations in this account: ${all.data.length}`);
  for (const c of all.data) {
    const flag = c.is_default ? "  <-- is_default, this is the one customers get" : "";
    console.log(`  ${c.id}  active=${c.active}  is_default=${c.is_default}${flag}`);
  }

  const targets = wanted ? all.data.filter((c) => c.id === wanted) : all.data;
  if (wanted && targets.length === 0) {
    console.log(`\n${wanted} is not in this account's configurations. Wrong mode, or wrong id.`);
    return;
  }

  const expected = CATALOGUE.map((e) => e.lookupKey);

  for (const summary of targets) {
    const c = await stripe.billingPortal.configurations.retrieve(summary.id);
    console.log("\n" + "=".repeat(70));
    console.log(`configuration ${c.id}   is_default=${c.is_default}  active=${c.active}`);
    console.log("=".repeat(70));

    // Raw, so our own field-name assumptions cannot hide anything.
    console.log("\nfeatures.subscription_update (verbatim from the API):");
    console.log(JSON.stringify(c.features?.subscription_update ?? null, null, 2));
    console.log("\nfeatures.subscription_cancel (verbatim from the API):");
    console.log(JSON.stringify(c.features?.subscription_cancel ?? null, null, 2));

    // Then the question actually asked, answered against the raw response.
    const update = c.features?.subscription_update;
    const entries = update?.products ?? null;
    console.log("\nresolved:");
    console.log(`  enabled                     ${update?.enabled}`);
    console.log(`  default_allowed_updates     ${JSON.stringify(update?.default_allowed_updates ?? null)}`);
    console.log(`  proration_behavior          ${update?.proration_behavior}`);
    console.log(`  products present            ${entries === null ? "FIELD ABSENT OR NULL" : `${entries.length} entry/entries`}`);

    if (Array.isArray(entries)) {
      for (const entry of entries) {
        let name = "(unreadable)";
        try {
          name = (await stripe.products.retrieve(entry.product)).name;
        } catch {
          /* a product we cannot read is still worth printing by id */
        }
        console.log(`    product ${entry.product}  ${name}`);
        for (const priceId of entry.prices ?? []) {
          try {
            const price = await stripe.prices.retrieve(priceId);
            const amount = price.unit_amount === null ? "?" : (price.unit_amount / 100).toFixed(2);
            const match = expected.includes(price.lookup_key) ? "expected" : "NOT IN OUR CATALOGUE";
            console.log(
              `      price ${priceId}  $${amount}/${price.recurring?.interval ?? "?"}` +
                `  lookup=${price.lookup_key ?? "none"}  active=${price.active}  [${match}]`,
            );
          } catch {
            console.log(`      price ${priceId}  (could not be read)`);
          }
        }
      }
    }

    console.log(`  cancel enabled              ${c.features?.subscription_cancel?.enabled}`);
    console.log(`  cancel mode                 ${c.features?.subscription_cancel?.mode}`);
    console.log(`  cancel proration            ${c.features?.subscription_cancel?.proration_behavior}`);
  }

  console.log("\nExpected lookup keys from our catalogue: " + expected.join(", "));
  console.log("Nothing was modified.\n");
}

main().catch((error) => {
  // Never let a Stripe error carry the key into a log.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n${message.replace(/sk_(test|live)_[A-Za-z0-9*_]+/g, "[redacted]")}\n`);
  process.exit(1);
});
