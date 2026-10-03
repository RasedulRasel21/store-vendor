// Which plan a store is on comes from the Partner API, not the Admin API.
//
// With Shopify App Pricing the plans live in the Partner Dashboard and Shopify hosts the
// page where a merchant picks one. The app never creates a charge: it asks what the shop
// is subscribed to and lets that decide what is switched on.
//
// Needs a Partner API client with the "Manage apps" permission, and three variables:
//   SHOPIFY_PARTNER_ORG_ID            the number in the Partner Dashboard URL
//   SHOPIFY_PARTNER_API_ACCESS_TOKEN  that client's token
//   SHOPIFY_APP_GID                   gid://shopify/App/<the app's id>

const API_VERSION = "2026-07";

const ACTIVE_SUBSCRIPTION = `query ActiveSubscription($appId: ID!, $shopId: ID!) {
  activeSubscription(appId: $appId, shopId: $shopId) {
    billingPeriod
    trialEndsAt
    cancelAtEndOfCycle
    items {
      handle
      description
    }
  }
}`;

export function partnerApiConfigured() {
  // eslint-disable-next-line no-undef
  const { SHOPIFY_PARTNER_ORG_ID, SHOPIFY_PARTNER_API_ACCESS_TOKEN, SHOPIFY_APP_GID } = process.env;
  return Boolean(SHOPIFY_PARTNER_ORG_ID && SHOPIFY_PARTNER_API_ACCESS_TOKEN && SHOPIFY_APP_GID);
}

/**
 * The shop's current subscription, or null when it has none. Throws when the Partner API
 * can't be reached or complains, so the caller can decide to keep the last known answer
 * rather than treat a network blip as "they stopped paying".
 *
 * @param {string} shopId the shop's GID, as the Admin API gives it
 */
export async function fetchActiveSubscription(shopId) {
  if (!partnerApiConfigured()) return { skipped: true };

  // eslint-disable-next-line no-undef
  const { SHOPIFY_PARTNER_ORG_ID, SHOPIFY_PARTNER_API_ACCESS_TOKEN, SHOPIFY_APP_GID } = process.env;

  const response = await fetch(
    `https://partners.shopify.com/${SHOPIFY_PARTNER_ORG_ID}/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_PARTNER_API_ACCESS_TOKEN,
      },
      body: JSON.stringify({
        query: ACTIVE_SUBSCRIPTION,
        variables: { appId: SHOPIFY_APP_GID, shopId },
      }),
      signal: AbortSignal.timeout(8000),
    },
  );

  const { data, errors } = await response.json().catch(() => ({}));
  if (!response.ok || errors) {
    throw new Error(`Partner API said ${response.status}: ${JSON.stringify(errors ?? "")}`.slice(0, 300));
  }

  return { subscription: data?.activeSubscription ?? null };
}

// Where Shopify hosts the plans for this app. Outside the app's own frame, so a redirect
// to it has to break out of the iframe.
export function planSelectionUrl(shop) {
  // eslint-disable-next-line no-undef
  const appHandle = process.env.SHOPIFY_APP_HANDLE;
  if (!appHandle) return null;

  const storeHandle = shop.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
}
