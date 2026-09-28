import { authenticate } from "../shopify.server";
import { recordDataRequest, redactCustomer, redactShop } from "../models/privacy.server";
import { reportError } from "../models/error-report.server";

// Shopify's mandatory privacy webhooks. authenticate.webhook verifies the HMAC and
// answers 401 to anything that isn't really from Shopify.
//
// Each one is answered for real and written down: what arrived, what was done, and when.
// See app/models/privacy.server.js for the work itself.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const shopDomain = payload?.shop_domain ?? shop;

  try {
    switch (topic) {
      case "CUSTOMERS_DATA_REQUEST":
        await recordDataRequest(shopDomain, payload);
        break;
      case "CUSTOMERS_REDACT":
        await redactCustomer(shopDomain, payload);
        break;
      case "SHOP_REDACT":
        await redactShop(shopDomain);
        break;
    }
  } catch (error) {
    // Shopify retries a failed privacy webhook, and these are the ones that must not be
    // quietly lost, so it is recorded and the failure handed back for the retry.
    await reportError(error, { context: `privacy:${topic}`, shop: shopDomain });
    throw error;
  }

  return new Response();
};
