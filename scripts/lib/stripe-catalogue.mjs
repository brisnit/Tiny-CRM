/**
 * What Tiny CRM sells in Stripe, in one place.
 *
 * Two scripts need this — `stripe-sync-prices.mjs` creates it and
 * `stripe-configure-portal.mjs` lists it in the Customer Portal — and
 * `scripts/check-config.ts` compares the amounts here against `src/lib/plans.ts`,
 * so a price that drifts from the pricing page is a failing check rather than a
 * surprise on somebody's invoice.
 *
 * Keeping it in a module rather than copied into each script is deliberate: this
 * codebase already has a list of migration filenames duplicated in nine places,
 * and every copy is a chance for one of them to be the stale one.
 *
 * ## One product per plan, and why
 *
 * The first version of this catalogue put both prices under a single "Tiny CRM"
 * product. That is a perfectly ordinary Stripe shape, and the Customer Portal
 * cannot use it: `subscription_update` switches a subscriber **between products**,
 * so two monthly prices in the same currency on one product give the portal
 * nothing to offer and it rejects the configuration. The portal opens with no
 * "Update plan" option and nothing in the application looks wrong.
 *
 * So each plan owns a product. `productLookup` goes into product metadata as
 * `tinycrm_product`, which is how the sync script finds a product again without
 * depending on its display name.
 *
 * Amounts are in cents and must match `priceCents` in src/lib/plans.ts.
 */

export const CURRENCY = "usd";

/**
 * Metadata value used by the pre-separation single product.
 *
 * Kept so `stripe-sync-prices.mjs` can recognise and adopt that product instead
 * of creating a duplicate alongside it — the original product holds a price that
 * live subscriptions reference, and a price cannot be moved between products.
 */
export const LEGACY_SHARED_PRODUCT_LOOKUP = "tinycrm_app";

export const CATALOGUE = [
  {
    plan: "plus",
    productLookup: "tinycrm_plus",
    name: "Tiny CRM Plus",
    description:
      "3 workspaces with 3 people each, 2,000 contacts, file attachments, 30 Tiny AI model answers a month.",
    lookupKey: "tinycrm_plus_monthly",
    envVar: "STRIPE_PRICE_PLUS",
    amountCents: 1000,
  },
  {
    plan: "pro",
    productLookup: "tinycrm_pro",
    name: "Tiny CRM Pro",
    // Deliberately does not mention document question answering: the capability
    // is still behind its rollout flag, and this text is shown to a customer on
    // Stripe's hosted checkout and portal pages. Update it when the flag goes on.
    description: "10 workspaces with 10 people each, 5,000 contacts, 60 Tiny AI model answers a month.",
    lookupKey: "tinycrm_pro_monthly",
    envVar: "STRIPE_PRICE_PRO",
    amountCents: 2000,
  },
];
