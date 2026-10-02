#!/usr/bin/env node
/**
 * Configures the Stripe Customer Portal so a subscriber can switch between Plus
 * and Pro, update their card, read their invoices, and cancel.
 *
 * ## Why this script exists
 *
 * `createPortalSession` in src/lib/billing/stripe.ts calls
 * `billingPortal.sessions.create({ customer, return_url })` with **no
 * `configuration` parameter**, so every session uses the account's *default*
 * portal configuration. A freshly created Stripe account or sandbox has plan
 * switching switched off and no products listed on that default — which is why
 * the portal opens with no "Update plan" option and nothing in the code looks
 * wrong. The gap is in Stripe's configuration, not in the application.
 *
 * Doing it here rather than by clicking through the dashboard means the live
 * account gets the identical configuration later from the same command, and the
 * reasoning is recorded next to the settings instead of in someone's memory.
 *
 * ## What it sets, and the one decision inside it
 *
 * Plan switching, card updates, invoice history, and cancellation. Cancellation
 * defaults to **at period end**, not immediately: a customer who cancels has paid
 * for the rest of the month and removing their workspaces the moment they click
 * is taking something they already paid for. The webhook handles both correctly —
 * a subscription that is `active` with `cancel_at_period_end` keeps its plan, and
 * access ends when Stripe finally reports `canceled`.
 *
 * Pass `--cancel-immediately` to configure the other behaviour, which is useful in
 * a sandbox because it makes the transition observable in one click instead of a
 * month later.
 *
 * Safety: the key is read from the terminal with echo off, never from argv. A live
 * key is refused unless `--live` is also passed. Idempotent — it updates the
 * existing default configuration rather than accumulating new ones.
 *
 * Usage:
 *   node scripts/stripe-configure-portal.mjs
 *   node scripts/stripe-configure-portal.mjs --cancel-immediately
 *   node scripts/stripe-configure-portal.mjs --live
 */

import Stripe from "stripe";

import { promptHidden } from "./lib/prompt-hidden.mjs";
import { CATALOGUE } from "./lib/stripe-catalogue.mjs";

function modeOf(key) {
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  return "unknown";
}

/**
 * The products and prices this portal should offer, resolved from the catalogue.
 *
 * One entry per plan, each naming its own product. That shape is not cosmetic: the
 * portal's `subscription_update` switches a subscriber **between products**, so two
 * monthly prices in the same currency on a single product give it nothing to offer
 * and Stripe rejects the configuration. Each plan's product is read from its price
 * rather than from metadata, because the price is the immutable anchor a
 * subscription actually references.
 */
async function resolveCatalogue(stripe) {
  const entries = [];

  for (const entry of CATALOGUE) {
    const found = await stripe.prices.list({ lookup_keys: [entry.lookupKey], active: true, limit: 2 });
    if (found.data.length === 0) {
      throw new Error(
        `No active price with lookup key ${entry.lookupKey}. Run ` +
          "`node scripts/stripe-sync-prices.mjs` first.",
      );
    }
    if (found.data.length > 1) {
      throw new Error(`More than one active price carries lookup key ${entry.lookupKey}.`);
    }

    const price = found.data[0];
    if (price.unit_amount !== entry.amountCents) {
      throw new Error(
        `Price ${price.id} is ${price.unit_amount} cents but the catalogue says ${entry.amountCents}. ` +
          "Reconcile before listing it in the portal.",
      );
    }

    const productId = typeof price.product === "string" ? price.product : price.product.id;
    const product = await stripe.products.retrieve(productId);
    entries.push({ entry, price, product });
  }

  // The failure this script exists to prevent, caught before Stripe has to.
  const productIds = new Set(entries.map((e) => e.product.id));
  if (productIds.size < entries.length) {
    throw new Error(
      `${entries.length} plans resolve to ${productIds.size} product(s). The Customer Portal switches ` +
        "between products, so each plan needs its own. Run `node scripts/stripe-sync-prices.mjs` to " +
        "separate them — it keeps the price that has subscriptions where it is.",
    );
  }

  return entries;
}

/**
 * The configuration a portal session will actually use.
 *
 * Reported explicitly, because "which configuration is this session using" is the
 * question that makes a missing portal feature confusing: the code names none, so
 * it is whichever one Stripe marks default, and that is not visible from the app.
 */
async function resolveDefaultConfiguration(stripe) {
  const all = await stripe.billingPortal.configurations.list({ limit: 100 });

  if (all.data.length === 0) return { existing: null, configurations: [] };

  const isDefault = all.data.find((c) => c.is_default);
  return { existing: isDefault ?? all.data[0], configurations: all.data, defaulted: Boolean(isDefault) };
}

async function main() {
  const wantLive = process.argv.includes("--live");
  const cancelImmediately = process.argv.includes("--cancel-immediately");

  const key = await promptHidden("Stripe secret key (input hidden): ");
  const mode = modeOf(key);

  if (mode === "unknown") {
    throw new Error("That does not look like a Stripe secret key (expected sk_test_… or sk_live_…).");
  }
  if (mode === "live" && !wantLive) {
    throw new Error(
      "That is a LIVE key and --live was not passed. Re-run with --live only when you intend to " +
        "change the portal real customers see.",
    );
  }
  if (mode === "test" && wantLive) {
    throw new Error("--live was passed but the key is a test key. Nothing was changed.");
  }

  const stripe = new Stripe(key, { apiVersion: "2026-09-30.endive", maxNetworkRetries: 1 });

  const account = await stripe.accounts.retrieve();
  console.log(`\nStripe account: ${account.settings?.dashboard?.display_name ?? account.id}`);
  console.log(`Mode: ${mode.toUpperCase()}`);
  console.log(`Cancellation: ${cancelImmediately ? "immediately" : "at period end"}\n`);

  if (mode === "live") {
    console.log("This changes the portal LIVE customers see. Ctrl+C within 5 seconds to abort.\n");
    await new Promise((r) => setTimeout(r, 5_000));
  }

  const catalogue = await resolveCatalogue(stripe);
  for (const { entry, price, product } of catalogue) {
    console.log(`  ${entry.plan.padEnd(5)} ${product.id}  ${price.id}  ($${price.unit_amount / 100}/month)`);
  }

  const { existing, configurations, defaulted } = await resolveDefaultConfiguration(stripe);
  console.log(`\n  portal configurations in this account: ${configurations.length}`);
  if (existing) {
    console.log(`  target: ${existing.id}${defaulted ? " (is_default)" : " (NOT marked default — see note below)"}`);
  } else {
    console.log("  target: none exist yet — one will be created and become the default");
  }

  const features = {
    // The missing piece. `default_allowed_updates: ["price"]` is what puts the
    // "Update plan" button in the portal at all; `products` is what it may switch
    // between. Listing only our two prices means a customer cannot land on some
    // other price that exists in the account.
    subscription_update: {
      enabled: true,
      default_allowed_updates: ["price"],
      proration_behavior: "create_prorations",
      // One entry per product, each listing that product's single monthly price.
      products: catalogue.map(({ product, price }) => ({ product: product.id, prices: [price.id] })),
    },
    subscription_cancel: {
      enabled: true,
      mode: cancelImmediately ? "immediately" : "at_period_end",
      proration_behavior: "none",
    },
    payment_method_update: { enabled: true },
    invoice_history: { enabled: true },
    customer_update: {
      enabled: true,
      // Not `email`: this application keys an account on its email address and
      // the webhook resolves accounts by stored id, so letting the portal change
      // it would create a Stripe customer whose email disagrees with the account.
      allowed_updates: ["address", "name", "tax_id"],
    },
  };

  const payload = {
    features,
    business_profile: {
      headline: "Tiny CRM — manage your subscription",
      // Deliberately no privacy_policy_url or terms_of_service_url: Tiny CRM has
      // no such pages yet, and pointing the portal at URLs that 404 is worse than
      // omitting them. Stripe requires them before a live portal launch, so this
      // is a prerequisite for go-live rather than an oversight.
    },
  };

  const configuration = existing
    ? await stripe.billingPortal.configurations.update(existing.id, payload)
    : await stripe.billingPortal.configurations.create(payload);

  // Read back rather than trusting the write, and report the two settings that
  // decide whether the portal can do what we just asked for.
  const verified = await stripe.billingPortal.configurations.retrieve(configuration.id);
  const update = verified.features.subscription_update;

  console.log("\n" + "=".repeat(68));
  console.log(`  configuration        ${verified.id}`);
  console.log(`  is_default           ${verified.is_default}`);
  console.log(`  plan switching       ${update.enabled ? "ENABLED" : "disabled"}`);
  console.log(`  switchable prices    ${(update.products ?? []).flatMap((p) => p.prices).join(", ") || "none"}`);
  console.log(`  allowed updates      ${(update.default_allowed_updates ?? []).join(", ") || "none"}`);
  console.log(`  cancellation         ${verified.features.subscription_cancel.enabled ? verified.features.subscription_cancel.mode : "disabled"}`);
  console.log(`  payment method       ${verified.features.payment_method_update.enabled ? "enabled" : "disabled"}`);
  console.log(`  invoice history      ${verified.features.invoice_history.enabled ? "enabled" : "disabled"}`);
  console.log("=".repeat(68));

  if (!verified.is_default) {
    console.log(
      "\nNOTE: this configuration is not the account default, and createPortalSession()\n" +
        "does not name one — so sessions will keep using the default instead. Either make\n" +
        "this one the default in the dashboard (Settings -> Billing -> Customer portal),\n" +
        "or pass `configuration` explicitly in src/lib/billing/stripe.ts.",
    );
  } else {
    console.log("\nSessions use the account default, which is this configuration. Reopen the portal.");
  }
  console.log();
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/\b[sr]k_(test|live)_[A-Za-z0-9*]+/g, "[redacted]");
  console.error(`\nPortal configuration failed: ${message}\n`);
  process.exitCode = 1;
});
