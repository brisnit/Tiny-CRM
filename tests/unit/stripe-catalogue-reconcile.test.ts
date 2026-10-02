import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { reconcile } from "../../scripts/stripe-sync-prices.mjs";
import { CATALOGUE, CURRENCY } from "../../scripts/lib/stripe-catalogue.mjs";

/**
 * The catalogue reconciler, against a stubbed Stripe.
 *
 * This runs against a real account holding real subscriptions, and the property
 * that matters is **what it refuses to touch**: a Stripe price is immutable,
 * including which product it belongs to, and a subscription references a price. So
 * the price carrying a live subscription cannot move, must not be archived, and
 * its product has to be the one that gets relabelled around it.
 *
 * The state being repaired is the one this project actually created: both monthly
 * prices under a single "Tiny CRM" product, which the Customer Portal refuses
 * because `subscription_update` switches subscribers between *products*. The
 * portal simply appears to have no plan-switcher, and nothing in the application
 * looks wrong — so the repair is worth testing rather than running hopefully.
 *
 * A stub rather than the real API because the real API cannot be asked to be in a
 * broken state on demand, and because a test that creates live Stripe objects is
 * not a test anyone will run twice.
 */

type StubPrice = {
  id: string;
  product: string;
  unit_amount: number;
  currency: string;
  recurring: { interval: string } | null;
  lookup_key: string | null;
  active: boolean;
};
type StubProduct = { id: string; name: string; description?: string; metadata: Record<string, string>; active: boolean };

/** A minimal Stripe stand-in that records what was done to it. */
function makeStripe(options: {
  products: StubProduct[];
  prices: StubPrice[];
  /** Price ids that have at least one subscription. */
  subscribed?: string[];
}) {
  const products = [...options.products];
  const prices = [...options.prices];
  const subscribed = new Set(options.subscribed ?? []);
  const log: string[] = [];
  let seq = 0;

  const stripe = {
    products: {
      list() {
        // The script iterates with `for await`, which works on an array's
        // async-iterable-compatible protocol via this generator.
        return (async function* () {
          for (const p of products.filter((p) => p.active)) yield p;
        })();
      },
      async retrieve(id: string) {
        const found = products.find((p) => p.id === id);
        if (!found) throw new Error(`No such product: ${id}`);
        return found;
      },
      async update(id: string, patch: Partial<StubProduct>) {
        const found = products.find((p) => p.id === id);
        if (!found) throw new Error(`No such product: ${id}`);
        Object.assign(found, patch);
        log.push(`product.update ${id} name="${found.name}" lookup=${found.metadata?.tinycrm_product}`);
        return found;
      },
      async create(data: Partial<StubProduct>) {
        seq += 1;
        const created: StubProduct = {
          id: `prod_new${seq}`,
          name: data.name ?? "",
          description: data.description,
          metadata: data.metadata ?? {},
          active: true,
        };
        products.push(created);
        log.push(`product.create ${created.id} name="${created.name}"`);
        return created;
      },
    },
    prices: {
      async list(params: { lookup_keys?: string[]; active?: boolean }) {
        const keys = params.lookup_keys ?? [];
        const data = prices.filter(
          (p) => keys.includes(p.lookup_key ?? "") && (params.active ? p.active : true),
        );
        return { data };
      },
      async create(data: Record<string, unknown>) {
        seq += 1;
        const key = data.lookup_key as string;
        if (data.transfer_lookup_key) {
          // Stripe moves the key off whatever price holds it.
          for (const p of prices) if (p.lookup_key === key) p.lookup_key = null;
          log.push(`lookup_key transferred: ${key}`);
        } else if (prices.some((p) => p.lookup_key === key && p.active)) {
          throw new Error(`lookup key ${key} already in use and transfer_lookup_key not set`);
        }
        const created: StubPrice = {
          id: `price_new${seq}`,
          product: data.product as string,
          unit_amount: data.unit_amount as number,
          currency: data.currency as string,
          recurring: { interval: (data.recurring as { interval: string }).interval },
          lookup_key: key,
          active: true,
        };
        prices.push(created);
        log.push(`price.create ${created.id} on ${created.product} amount=${created.unit_amount}`);
        return created;
      },
      async update(id: string, patch: Partial<StubPrice>) {
        const found = prices.find((p) => p.id === id);
        if (!found) throw new Error(`No such price: ${id}`);
        Object.assign(found, patch);
        log.push(`price.update ${id} active=${found.active}`);
        return found;
      },
    },
    subscriptions: {
      async list(params: { price?: string }) {
        return { data: subscribed.has(params.price ?? "") ? [{ id: "sub_stub" }] : [] };
      },
      // Guard: nothing in reconcile may cancel or modify a subscription.
      async cancel() {
        throw new Error("reconcile must never cancel a subscription");
      },
      async update() {
        throw new Error("reconcile must never modify a subscription");
      },
    },
  };

  return { stripe, products, prices, log };
}

const plus = CATALOGUE.find((c: { plan: string }) => c.plan === "plus")!;
const pro = CATALOGUE.find((c: { plan: string }) => c.plan === "pro")!;

/** The exact broken state this project created in the sandbox. */
function brokenState() {
  return makeStripe({
    products: [
      {
        id: "prod_shared",
        name: "Tiny CRM",
        metadata: { tinycrm_product: "tinycrm_app" },
        active: true,
      },
    ],
    prices: [
      {
        id: "price_plus_live", product: "prod_shared", unit_amount: plus.amountCents,
        currency: CURRENCY, recurring: { interval: "month" }, lookup_key: plus.lookupKey, active: true,
      },
      {
        id: "price_pro_old", product: "prod_shared", unit_amount: pro.amountCents,
        currency: CURRENCY, recurring: { interval: "month" }, lookup_key: pro.lookupKey, active: true,
      },
    ],
    // Plus was purchased; Pro never was.
    subscribed: ["price_plus_live"],
  });
}

describe("separating a shared product without disturbing a live subscription", () => {
  test("the subscribed price keeps its id, its product, and stays active", async () => {
    const { stripe, prices, log } = brokenState();
    const results = await reconcile(stripe as never);

    const plusResult = results.find((r: { plan: string }) => r.plan === "plus")!;
    assert.equal(plusResult.priceId, "price_plus_live", "the live price id must not change");
    assert.equal(plusResult.productId, "prod_shared", "it keeps the product it is attached to");
    assert.equal(plusResult.created, false, "no replacement price is created for Plus");

    const livePrice = prices.find((p) => p.id === "price_plus_live")!;
    assert.equal(livePrice.active, true, "the live price must not be archived");
    assert.equal(livePrice.product, "prod_shared", "a price cannot move product, and must not be asked to");

    assert.ok(
      !log.some((l) => l.startsWith("price.update price_plus_live")),
      `the live price must not be modified at all — log: ${log.join(" | ")}`,
    );
  });

  test("the shared product is relabelled as the plan that kept it", async () => {
    const { stripe, products } = brokenState();
    await reconcile(stripe as never);

    const shared = products.find((p) => p.id === "prod_shared")!;
    assert.equal(shared.name, plus.name, 'the "Tiny CRM" product becomes "Tiny CRM Plus"');
    assert.equal(shared.metadata.tinycrm_product, plus.productLookup);
    assert.equal(shared.metadata.plan, "plus");
  });

  test("only the unsubscribed plan gets a new product and price", async () => {
    const { stripe, products, log } = brokenState();
    const results = await reconcile(stripe as never);

    const proResult = results.find((r: { plan: string }) => r.plan === "pro")!;
    assert.equal(proResult.created, true, "Pro is the replacement being created");
    assert.notEqual(proResult.productId, "prod_shared", "Pro moves to its own product");
    assert.notEqual(proResult.priceId, "price_pro_old", "with a new price, since a price cannot move");

    const created = products.filter((p) => p.id.startsWith("prod_new"));
    assert.equal(created.length, 1, "exactly one product is created, not two");
    assert.equal(created[0]!.name, pro.name);

    assert.ok(log.includes(`lookup_key transferred: ${pro.lookupKey}`), "the lookup key is transferred, not duplicated");
  });

  test("the abandoned price is archived, never deleted", async () => {
    const { stripe, prices } = brokenState();
    await reconcile(stripe as never);

    const old = prices.find((p) => p.id === "price_pro_old");
    assert.ok(old, "the old price still exists — Stripe does not delete prices, and historical invoices reference them");
    assert.equal(old!.active, false, "but it is deactivated so nothing new can subscribe to it");
  });

  test("each plan ends up on a distinct product, which is what the portal requires", async () => {
    const { stripe } = brokenState();
    const results = await reconcile(stripe as never);
    const ids = new Set(results.map((r: { productId: string }) => r.productId));
    assert.equal(ids.size, results.length, "one product per plan");
  });

  test("running it again changes nothing", async () => {
    const state = brokenState();
    const first = await reconcile(state.stripe as never);

    const before = state.log.length;
    const second = await reconcile(state.stripe as never);

    assert.deepEqual(
      second.map((r: { plan: string; priceId: string }) => [r.plan, r.priceId]),
      first.map((r: { plan: string; priceId: string }) => [r.plan, r.priceId]),
      "the same price ids come back",
    );
    assert.ok(
      second.every((r: { created: boolean }) => r.created === false),
      "nothing is created on a second run",
    );
    const added = state.log.slice(before).filter((l) => l.includes("create"));
    assert.equal(added.length, 0, `no create calls on a second run — got: ${added.join(" | ")}`);
  });

  test("it refuses rather than migrating a live subscription when both plans are in use", async () => {
    const { stripe } = makeStripe({
      products: [{ id: "prod_shared", name: "Tiny CRM", metadata: { tinycrm_product: "tinycrm_app" }, active: true }],
      prices: [
        { id: "p_plus", product: "prod_shared", unit_amount: plus.amountCents, currency: CURRENCY, recurring: { interval: "month" }, lookup_key: plus.lookupKey, active: true },
        { id: "p_pro", product: "prod_shared", unit_amount: pro.amountCents, currency: CURRENCY, recurring: { interval: "month" }, lookup_key: pro.lookupKey, active: true },
      ],
      subscribed: ["p_plus", "p_pro"],
    });

    await assert.rejects(
      () => reconcile(stripe as never),
      /billing decision/,
      "moving a subscribed price is a billing decision, not something a sync script does",
    );
  });

  test("a mismatched amount is refused instead of being replaced silently", async () => {
    const { stripe } = makeStripe({
      products: [{ id: "prod_a", name: "Tiny CRM Plus", metadata: { tinycrm_product: plus.productLookup }, active: true }],
      prices: [
        { id: "p_wrong", product: "prod_a", unit_amount: 1400, currency: CURRENCY, recurring: { interval: "month" }, lookup_key: plus.lookupKey, active: true },
      ],
    });

    await assert.rejects(() => reconcile(stripe as never), /immutable/);
  });

  test("a clean account with nothing yet creates one product and price per plan", async () => {
    const { stripe, products, prices } = makeStripe({ products: [], prices: [] });
    const results = await reconcile(stripe as never);

    assert.equal(results.length, CATALOGUE.length);
    assert.equal(products.length, CATALOGUE.length, "one product per plan");
    assert.equal(prices.length, CATALOGUE.length, "one price per plan");
    assert.ok(results.every((r: { created: boolean }) => r.created));
  });
});
