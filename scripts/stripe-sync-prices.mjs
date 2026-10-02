#!/usr/bin/env node
/**
 * Creates (or finds) the Stripe product and the two recurring monthly prices
 * Tiny CRM sells, and prints the price ids to put in the environment.
 *
 * Idempotent, and in a specific sense worth stating: it is safe to run twice
 * because it looks prices up by `lookup_key` before creating anything, and a
 * **price in Stripe is immutable**. If a price already exists under the expected
 * lookup key with a different amount, this script refuses rather than
 * "fixing" it — changing what customers pay means creating a new price and
 * deciding what happens to existing subscriptions, which is a business decision
 * and not something a sync script should make on its own.
 *
 * Safety:
 *   - The secret key is read from the terminal with echo off. Never from argv
 *     (visible in `ps` and in shell history), never from a file.
 *   - Nothing is printed that could reveal the key. The mode (test or live) is
 *     derived from its prefix and reported as a word.
 *   - It refuses to touch a live account unless `--live` is passed as well, so
 *     pasting the wrong key cannot quietly create live prices.
 *
 * Usage:
 *   node scripts/stripe-sync-prices.mjs          # test mode
 *   node scripts/stripe-sync-prices.mjs --live   # live mode, after review
 */

import Stripe from "stripe";
import { pathToFileURL } from "node:url";
import { promptHidden } from "./lib/prompt-hidden.mjs";
import { CATALOGUE, CURRENCY } from "./lib/stripe-catalogue.mjs";



function modeOf(key) {
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  return "unknown";
}

/**
 * Every product in the account, with client-side metadata filtering.
 *
 * `products.search` is not used: its index is eventually consistent, so a product
 * created moments ago can be invisible to it, and this script both creates and
 * then looks up products in one run.
 */
async function allProducts(stripe) {
  const out = [];
  for await (const product of stripe.products.list({ limit: 100, active: true })) {
    out.push(product);
  }
  return out;
}

/** Does any subscription — in any state — reference this price? */
async function priceIsInUse(stripe, priceId) {
  const subs = await stripe.subscriptions.list({ price: priceId, status: "all", limit: 1 });
  return subs.data.length > 0;
}

/**
 * Brings the account in line with the catalogue, anchored on prices.
 *
 * ## Why the price is the anchor rather than the product
 *
 * A Stripe price is immutable, *including which product it belongs to*, and a
 * subscription references a price. So the price is the thing that cannot be moved
 * and must not be disturbed; the product is the thing that can be renamed and
 * re-tagged around it. Resolving a plan's product *from* its existing price is
 * therefore the only ordering that can repair a mis-shaped catalogue without
 * touching a live subscription.
 *
 * ## The repair this exists for
 *
 * The first version of this script put both prices under one product. The
 * Customer Portal switches subscribers *between products*, so it refuses that
 * shape, and the portal appears to simply lack a plan-switcher. Separating them
 * means one plan keeps the original product and the other needs a new one.
 *
 * Which plan moves is not a free choice: the plan whose price has subscriptions
 * **keeps** its product, because its price cannot follow it. The other plan gets a
 * fresh product and a fresh price, its lookup key transferred, and its old price
 * deactivated so nothing can subscribe to it again.
 */
export async function reconcile(stripe) {
  const products = await allProducts(stripe);
  const byLookup = new Map();
  for (const product of products) {
    const lookup = product.metadata?.tinycrm_product;
    if (lookup) byLookup.set(lookup, product);
  }

  // Pass 1: find each plan's existing active price, and the product it sits on.
  const state = [];
  for (const entry of CATALOGUE) {
    const found = await stripe.prices.list({ lookup_keys: [entry.lookupKey], active: true, limit: 2 });
    if (found.data.length > 1) {
      throw new Error(`More than one active price carries lookup key ${entry.lookupKey}.`);
    }
    const price = found.data[0] ?? null;

    if (price) {
      const matches =
        price.unit_amount === entry.amountCents &&
        price.currency === CURRENCY &&
        price.recurring?.interval === "month";
      if (!matches) {
        throw new Error(
          `Price ${price.id} uses lookup key ${entry.lookupKey} but does not match the catalogue ` +
            `(have ${price.unit_amount} ${price.currency}/${price.recurring?.interval}, want ` +
            `${entry.amountCents} ${CURRENCY}/month). Stripe prices are immutable: decide what ` +
            "happens to existing subscriptions, then create the replacement deliberately.",
        );
      }
    }

    state.push({
      entry,
      price,
      productId: price ? (typeof price.product === "string" ? price.product : price.product.id) : null,
      inUse: price ? await priceIsInUse(stripe, price.id) : false,
    });
  }

  // Pass 2: detect two plans sharing one product, and decide which one moves.
  const shared = new Map();
  for (const row of state) {
    if (!row.productId) continue;
    shared.set(row.productId, [...(shared.get(row.productId) ?? []), row]);
  }

  for (const [productId, rows] of shared) {
    if (rows.length < 2) continue;

    // The plan with subscriptions keeps the product. If none has subscriptions,
    // the first in catalogue order keeps it — an arbitrary but stable choice, and
    // it only arises on an account where nothing has been sold.
    const keeper = rows.find((r) => r.inUse) ?? rows[0];
    const movers = rows.filter((r) => r !== keeper);

    console.log(
      `\n  ${productId} carries ${rows.length} plans, which the Customer Portal cannot switch between.`,
    );
    console.log(`  keeping: ${keeper.entry.plan}${keeper.inUse ? " (has subscriptions — its price cannot move)" : ""}`);

    for (const mover of movers) {
      console.log(`  moving:  ${mover.entry.plan} to its own product`);
      if (mover.inUse) {
        throw new Error(
          `Both ${keeper.entry.plan} and ${mover.entry.plan} have subscriptions on product ${productId}. ` +
            "Separating them would require migrating a live subscription to a new price, which is a " +
            "billing decision and not something this script will do on its own.",
        );
      }
      // Marked so pass 3 creates a new product and price for it.
      mover.mustMove = true;
      mover.oldPrice = mover.price;
      mover.price = null;
      mover.productId = null;
    }
  }

  // Pass 3: ensure every plan has its own correctly-tagged product and a price.
  const results = [];

  for (const row of state) {
    const { entry } = row;
    let product;

    if (row.productId) {
      // Adopt the product the existing price already sits on, and bring its name,
      // description and metadata in line. This is what re-labels the original
      // shared "Tiny CRM" product as "Tiny CRM Plus" without touching its price.
      product = await stripe.products.update(row.productId, {
        name: entry.name,
        description: entry.description,
        metadata: { tinycrm_product: entry.productLookup, plan: entry.plan },
      });
      console.log(`  ${entry.plan}: product ${product.id} adopted and relabelled "${product.name}"`);
    } else {
      const existing = byLookup.get(entry.productLookup);
      if (existing) {
        product = await stripe.products.update(existing.id, {
          name: entry.name,
          description: entry.description,
          metadata: { tinycrm_product: entry.productLookup, plan: entry.plan },
        });
        console.log(`  ${entry.plan}: product ${product.id} reused`);
      } else {
        product = await stripe.products.create(
          {
            name: entry.name,
            description: entry.description,
            metadata: { tinycrm_product: entry.productLookup, plan: entry.plan },
          },
          { idempotencyKey: `product:${entry.productLookup}` },
        );
        console.log(`  ${entry.plan}: product ${product.id} created`);
      }
      byLookup.set(entry.productLookup, product);
    }

    if (row.price) {
      console.log(`  ${entry.plan}: price ${row.price.id} reused ($${entry.amountCents / 100}/month)`);
      results.push({ ...entry, priceId: row.price.id, productId: product.id, created: false });
      continue;
    }

    // `transfer_lookup_key` moves the key off whatever price holds it, which is
    // required because lookup keys are unique per account and the old price still
    // has this one.
    const price = await stripe.prices.create({
      product: product.id,
      currency: CURRENCY,
      unit_amount: entry.amountCents,
      recurring: { interval: "month" },
      lookup_key: entry.lookupKey,
      transfer_lookup_key: true,
      nickname: `${entry.name} — monthly`,
      metadata: { plan: entry.plan },
    });
    console.log(`  ${entry.plan}: price ${price.id} created ($${entry.amountCents / 100}/month)`);

    if (row.oldPrice) {
      // Deactivated, not deleted — Stripe does not delete prices, and an archived
      // price keeps any historical invoice that referenced it intelligible.
      await stripe.prices.update(row.oldPrice.id, { active: false });
      console.log(`  ${entry.plan}: price ${row.oldPrice.id} archived (was on the shared product)`);
    }

    results.push({ ...entry, priceId: price.id, productId: product.id, created: true });
  }

  return results;
}

async function main() {
  const wantLive = process.argv.includes("--live");

  const key = await promptHidden("Stripe secret key (input hidden): ");
  const mode = modeOf(key);

  if (mode === "unknown") {
    throw new Error("That does not look like a Stripe secret key (expected sk_test_… or sk_live_…).");
  }
  if (mode === "live" && !wantLive) {
    throw new Error(
      "That is a LIVE key and --live was not passed. Re-run with --live only when you intend " +
        "to create real prices customers can be charged against.",
    );
  }
  if (mode === "test" && wantLive) {
    throw new Error("--live was passed but the key is a test key. Nothing was changed.");
  }

  const stripe = new Stripe(key, { apiVersion: "2026-09-30.endive", maxNetworkRetries: 1 });

  const account = await stripe.accounts.retrieve();
  console.log(`\nStripe account: ${account.settings?.dashboard?.display_name ?? account.id}`);
  console.log(`Mode: ${mode.toUpperCase()}\n`);

  if (mode === "live") {
    console.log("This will create LIVE prices. Ctrl+C within 5 seconds to abort.\n");
    await new Promise((r) => setTimeout(r, 5_000));
  }

  const results = await reconcile(stripe);

  console.log("\n" + "=".repeat(68));
  console.log(`Set these for the ${mode.toUpperCase()} environment:\n`);
  for (const r of results) {
    console.log(`  ${r.envVar}=${r.priceId}${r.created ? "   (NEW — update your environment)" : ""}`);
  }
  console.log("\nOne product per plan, which is what the Customer Portal switches between:");
  for (const r of results) {
    console.log(`  ${r.name.padEnd(15)} ${r.productId}`);
  }
  console.log("\nPrice ids are not secrets — but set them as environment variables");
  console.log("alongside STRIPE_SECRET_KEY so test and live cannot be mixed up.");
  console.log("=".repeat(68) + "\n");
}

// `pathToFileURL`, not string interpolation: this project's own directory name
// contains a space, which import.meta.url percent-encodes and process.argv[1]
// does not — so comparing the two as strings is always false here, and the script
// silently does nothing when run.
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main().catch((error) => {
  // Scrub anything that looks like a key, in case it reaches an error message.
  //
  // The character class includes `*` deliberately: Stripe's own "Invalid API Key
  // provided" error partially masks the key as `sk_test_****************abcd`,
  // keeping the last four characters. That is four characters more than this
  // script promises to show, so the masked form is scrubbed too.
  const message = String(error?.message ?? error).replace(
    /\b[sr]k_(test|live)_[A-Za-z0-9*]+/g,
    "[redacted]",
  );
  console.error(`\nSync failed: ${message}\n`);
  process.exitCode = 1;
});
