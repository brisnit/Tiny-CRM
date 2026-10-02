#!/usr/bin/env node
/**
 * Exercises a real renewal failure and recovery, using a Stripe test clock.
 *
 * ## What this proves that nothing else can
 *
 * `past_due` is the one entitlement state the application reaches by *waiting*.
 * An established subscription's renewal fails a month after it was created, and
 * `entitlementFor` deliberately **keeps the plan** while Stripe retries the card —
 * because an expired card is not a cancellation and evicting someone mid-dunning
 * punishes them for it. That behaviour has unit coverage, but unit coverage cannot
 * tell you whether Stripe really emits what the handler expects, in the order it
 * expects, a billing period later.
 *
 * A test clock is the only way to reach it without waiting a month. It is also the
 * only way to reach it *honestly*: the alternative — writing `past_due` into the
 * database — would test nothing but our own ability to write a string.
 *
 * Distinct from the unpaid-subscription case. A subscription created with
 * `payment_behavior: default_incomplete` is `incomplete`: its first payment never
 * happened, so it grants nothing. This script covers the opposite shape — a
 * subscription that **was** paid, then failed on renewal, and must keep access.
 *
 * ## Why a dedicated customer
 *
 * A Stripe customer must be created *attached* to a test clock; an existing one
 * cannot be moved onto it. So this creates its own customer and names the Tiny CRM
 * account in `metadata.userId`, which is the first thing `resolveUserId` in the
 * webhook looks at.
 *
 * ## Safety
 *
 * Test mode only, with no `--live` escape hatch: test clocks do not exist in live
 * mode, and a live key here could only mean a mistake. The key is read from the
 * terminal with echo off. Every object it creates belongs to the clock, so
 * `--cleanup` deletes all of it in one call.
 *
 * Usage:
 *   node scripts/stripe-test-clock-dunning.mjs --user-id=u_clocktest
 *   node scripts/stripe-test-clock-dunning.mjs --cleanup=clock_xxx
 */

import Stripe from "stripe";
import { pathToFileURL } from "node:url";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

import { promptHidden } from "./lib/prompt-hidden.mjs";
import { CATALOGUE } from "./lib/stripe-catalogue.mjs";

/**
 * Test **card tokens**, not the shared `pm_card_*` PaymentMethod ids.
 *
 * The first version of this script used `pm_card_visa` and
 * `pm_card_chargeCustomerFail` directly. Those are singleton objects: once one is
 * attached to a customer it cannot be attached to another, and attaching to a
 * test-clock customer does not behave the way attaching to an ordinary one does.
 * The run failed with "The payment method must be attached to the customer" —
 * raised not by the attach but by the *next* call, which tried to make an
 * unattached method the default.
 *
 * Tokens are designed to be redeemed repeatedly, so a fresh PaymentMethod is
 * created from one per run and belongs to exactly this customer.
 *
 * `tok_chargeCustomerFail` produces a card that attaches cleanly and then
 * **declines when charged** — which is precisely a renewal failure: the card is on
 * file, nothing looks wrong, and the charge fails anyway.
 */
const TOKEN_GOOD = "tok_visa";
const TOKEN_FAILING = "tok_chargeCustomerFail";

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

/**
 * Run state, so a crash does not orphan Stripe objects.
 *
 * The first version kept nothing. It failed partway through phase 1 and left a
 * clock and a customer behind with no record of them — recoverable only because
 * the ids happened to be in the terminal scrollback. Every object created here is
 * now written down as soon as it exists, so a rerun can finish the job or delete
 * it, and neither depends on anyone having kept the output.
 *
 * Ids only: no key, no card data, nothing secret. Git-ignored regardless.
 */
const STATE_FILE = new URL("../.stripe-test-clock-state.json", import.meta.url);

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeState(patch) {
  const next = { ...(readState() ?? {}), ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + "\n");
  return next;
}

function clearState() {
  try {
    rmSync(STATE_FILE);
  } catch {
    // Never existed, or already gone.
  }
}

function modeOf(key) {
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  return "unknown";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Creates a card from a test token, attaches it, proves it attached, and only then
 * makes it the customer's default.
 *
 * The verification step is the point. Setting an unattached method as the default
 * fails on the *update* call, which makes the error read as though the default is
 * the problem when the attach is. Re-reading the PaymentMethod and asserting it
 * names this customer turns that into a precise failure at the step that actually
 * went wrong.
 */
async function attachDefaultCard(stripe, customerId, token, label) {
  const method = await stripe.paymentMethods.create({ type: "card", card: { token } });
  await stripe.paymentMethods.attach(method.id, { customer: customerId });

  const confirmed = await stripe.paymentMethods.retrieve(method.id);
  const attachedTo = typeof confirmed.customer === "string" ? confirmed.customer : confirmed.customer?.id;
  if (attachedTo !== customerId) {
    throw new Error(
      `Payment method ${method.id} did not attach to ${customerId} (reports ${attachedTo ?? "none"}). ` +
        "Not setting it as the default.",
    );
  }

  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: method.id },
  });
  console.log(`  card: ${method.id} attached and set as default (${label})`);
  return method.id;
}

/**
 * Advances a clock and waits for it to settle.
 *
 * Advancing is asynchronous: the clock reports `advancing` while Stripe replays
 * every scheduled billing operation, and the webhooks we care about are emitted
 * during that window. Returning before it is `ready` would mean reading state
 * mid-flight and reporting whatever happened to have landed.
 */
async function advanceTo(stripe, clockId, frozenTime, label) {
  process.stdout.write(`  advancing clock -> ${new Date(frozenTime * 1000).toISOString()} (${label}) `);
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: frozenTime });

  for (let i = 0; i < 90; i += 1) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId);
    if (clock.status === "ready") {
      process.stdout.write(" ready\n");
      return;
    }
    if (clock.status === "internal_failure") {
      throw new Error("The test clock reported an internal failure while advancing.");
    }
    process.stdout.write(".");
    await sleep(2_000);
  }
  throw new Error("The test clock did not become ready within three minutes.");
}

/** Prints the state the webhook will have derived its entitlement from. */
async function report(stripe, subscriptionId, heading) {
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] });
  const invoice = typeof sub.latest_invoice === "string" ? null : sub.latest_invoice;
  console.log(`\n  ${heading}`);
  console.log(`    subscription status   ${sub.status}`);
  console.log(`    cancel_at_period_end  ${sub.cancel_at_period_end}`);
  if (invoice) {
    console.log(`    latest invoice        ${invoice.id}  status=${invoice.status}  attempted=${invoice.attempted}`);
    console.log(`    amount due            ${(invoice.amount_due ?? 0) / 100} ${String(invoice.currency).toUpperCase()}`);
  }
  console.log(`    EXPECT IN TINY CRM    ${expectationFor(sub.status)}`);
  return sub;
}

function expectationFor(status) {
  switch (status) {
    case "active":
      return "plan granted, planStatus=active";
    case "past_due":
      return "plan KEPT, planStatus=past_due, amber warning on the billing page";
    case "incomplete":
      return "no access — first payment never succeeded";
    case "canceled":
    case "unpaid":
      return "no access, planStatus mirrors Stripe";
    default:
      return `fails closed to Free (unrecognised status "${status}")`;
  }
}

async function cleanup(stripe, clockId) {
  console.log(`\nDeleting test clock ${clockId} and everything attached to it…`);
  await stripe.testHelpers.testClocks.del(clockId);
  console.log("Done. The customer, subscription and invoices created by this run are gone.\n");
}

async function main() {
  if (process.argv.includes("--live")) {
    throw new Error("There is no live mode for this script. Test clocks exist only in test mode.");
  }

  const cleanupId = arg("cleanup");
  const userId = arg("user-id");
  const fresh = process.argv.includes("--fresh");

  if (!cleanupId && !userId) {
    throw new Error(
      "Pass --user-id=<tiny crm user id> to run, or --cleanup=<clock id> to tear down a previous run.",
    );
  }

  const previous = readState();
  if (!cleanupId && previous?.clockId && !fresh) {
    throw new Error(
      `A previous run left objects behind:\n` +
        `    clock     ${previous.clockId}\n` +
        `    customer  ${previous.customerId ?? "(none recorded)"}\n` +
        `    reached   ${previous.phase ?? "nothing"}\n\n` +
        `  Re-run with --fresh to delete that clock and start over, or tear it down with\n` +
        `    node scripts/stripe-test-clock-dunning.mjs --cleanup=${previous.clockId}\n` +
        `  Refusing to create a second clock alongside the first.`,
    );
  }

  const key = await promptHidden("Stripe TEST secret key (input hidden): ");
  const mode = modeOf(key);
  if (mode !== "test") {
    throw new Error(
      mode === "live"
        ? "That is a LIVE key. Test clocks do not exist in live mode and this script will not use one."
        : "That does not look like a Stripe test secret key (expected sk_test_…).",
    );
  }

  const stripe = new Stripe(key, { apiVersion: "2026-09-30.endive", maxNetworkRetries: 1 });

  const account = await stripe.accounts.retrieve();
  console.log(`\nStripe account: ${account.settings?.dashboard?.display_name ?? account.id}`);
  console.log("Mode: TEST\n");

  if (cleanupId) {
    await cleanup(stripe, cleanupId);
    if (readState()?.clockId === cleanupId) clearState();
    return;
  }

  if (fresh && previous?.clockId) {
    console.log(`  --fresh: removing the previous run's clock ${previous.clockId} first.`);
    try {
      await cleanup(stripe, previous.clockId);
    } catch (error) {
      // Already deleted by hand, most likely. Say so and carry on rather than
      // refusing to start over because the thing we wanted gone is gone.
      console.log(`  (could not delete it: ${error.message} — continuing)`);
    }
    clearState();
  }

  const plus = CATALOGUE.find((c) => c.plan === "plus");
  const prices = await stripe.prices.list({ lookup_keys: [plus.lookupKey], active: true, limit: 2 });
  if (prices.data.length !== 1) {
    throw new Error(
      `Expected exactly one active price with lookup key ${plus.lookupKey}, found ${prices.data.length}. ` +
        "Run `node scripts/stripe-sync-prices.mjs` first.",
    );
  }
  const price = prices.data[0];
  console.log(`  price: ${price.id} ($${price.unit_amount / 100}/month)`);

  // ---- Phase 1: a customer on a clock, with a card that works ------------
  const start = Math.floor(Date.now() / 1000);
  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: start,
    name: `tiny-crm dunning ${new Date(start * 1000).toISOString()}`,
  });
  console.log(`  test clock: ${clock.id}`);
  writeState({ clockId: clock.id, userId, phase: "clock created" });

  const customer = await stripe.customers.create({
    test_clock: clock.id,
    email: "clock-test@tinycrm.local",
    name: "Clock Test",
    // How the webhook resolves this to a Tiny CRM account. Without it the handler
    // would correctly report `unknown_account` and change nothing.
    metadata: { userId },
  });
  console.log(`  customer: ${customer.id}  (metadata.userId=${userId})`);
  writeState({ customerId: customer.id, phase: "customer created" });

  const goodCard = await attachDefaultCard(stripe, customer.id, TOKEN_GOOD, "working card");

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: price.id }],
    metadata: { userId, plan: plus.plan },
  });
  console.log(`  subscription: ${subscription.id}`);
  writeState({ subscriptionId: subscription.id, phase: "subscribed" });

  await report(stripe, subscription.id, "PHASE 1 — first payment, with a working card");
  writeState({ phase: "phase 1 complete" });
  console.log("\n  Check Tiny CRM: the account should now be on Plus.");

  // ---- Phase 2: swap in a failing card, then let the renewal come due ----
  console.log("\n  Swapping the default payment method for one that declines when charged…");
  await attachDefaultCard(stripe, customer.id, TOKEN_FAILING, "declines when charged");

  const item = subscription.items.data[0];
  const periodEnd = item.current_period_end ?? subscription.current_period_end;
  if (!periodEnd) throw new Error("Could not determine the subscription's period end.");

  // An hour past the boundary, so the renewal invoice is created *and* attempted
  // rather than landing exactly on it.
  await advanceTo(stripe, clock.id, periodEnd + 3_600, "one hour past renewal");

  await report(stripe, subscription.id, "PHASE 2 — renewal attempted with a failing card");
  writeState({ phase: "phase 2 complete — past_due reached" });
  console.log("\n  Check Tiny CRM: the account should STILL be on Plus, with planStatus=past_due");
  console.log("  and the amber 'last payment did not go through' notice. Access is kept while");
  console.log("  Stripe retries — an expired card is not a cancellation.");

  // ---- Phase 3: recovery -------------------------------------------------
  console.log("\n  Restoring a working card and paying the open invoice…");
  await stripe.customers.update(customer.id, {
    invoice_settings: { default_payment_method: goodCard },
  });

  const open = await stripe.invoices.list({ customer: customer.id, status: "open", limit: 1 });
  if (open.data.length === 0) {
    console.log("  No open invoice found — Stripe may have already voided it. Skipping the payment.");
  } else {
    await stripe.invoices.pay(open.data[0].id, { payment_method: goodCard });
    console.log(`  paid invoice ${open.data[0].id}`);
  }

  await report(stripe, subscription.id, "PHASE 3 — after recovery");
  writeState({ phase: "phase 3 complete — recovered" });
  console.log("\n  Check Tiny CRM: planStatus should be back to active and the warning gone.");

  console.log("\n" + "=".repeat(70));
  console.log("Tear this run down when you are finished:");
  console.log(`  node scripts/stripe-test-clock-dunning.mjs --cleanup=${clock.id}`);
  console.log("That deletes the clock and every object attached to it.");
  console.log("=".repeat(70) + "\n");
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    const message = String(error?.message ?? error).replace(
      /\b[sr]k_(test|live)_[A-Za-z0-9*]+/g,
      "[redacted]",
    );
    console.error(`\nTest clock run failed: ${message}\n`);
    process.exitCode = 1;
  });
}
