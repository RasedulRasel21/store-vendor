import { authenticate } from "../shopify.server";
import db from "../db.server";

// Mandatory privacy webhooks (customers/data_request, customers/redact, shop/redact).
// authenticate.webhook verifies the HMAC and returns 401 for invalid requests.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      // No customer data is stored yet. Once vendor orders exist, compile the
      // customer's data for the merchant within 30 days.
      break;
    case "CUSTOMERS_REDACT":
      // No customer data is stored yet. Once vendor orders exist, redact the
      // customer's personal data for payload.orders_to_redact.
      break;
    case "SHOP_REDACT": {
      // Sent 48 hours after uninstall: erase everything stored for this shop.
      // Deleting vendors cascades to their users, product links and activity.
      const shopDomain = payload.shop_domain ?? shop;
      await db.$transaction([
        db.vendorProduct.deleteMany({ where: { shop: shopDomain } }),
        db.shopCollection.deleteMany({ where: { shop: shopDomain } }),
        db.vendor.deleteMany({ where: { shop: shopDomain } }),
        db.shopSettings.deleteMany({ where: { shop: shopDomain } }),
        db.session.deleteMany({ where: { shop: shopDomain } }),
      ]);
      break;
    }
  }

  return new Response();
};
