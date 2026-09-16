import { authenticate } from "../shopify.server";
import { recordStoreFulfillment } from "../models/vendor-order.server";

// Keeps vendor orders in step when anyone ships lines, including the merchant in Shopify admin.
// A parcel the vendor portal just created is recognised by its fulfillment id and skipped.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const orderGid = payload?.order_id ? `gid://shopify/Order/${payload.order_id}` : null;
  const lines = (payload?.line_items ?? [])
    .map((line) => ({
      lineItemId: line.admin_graphql_api_id ?? (line.id ? `gid://shopify/LineItem/${line.id}` : null),
      quantity: Number(line.quantity ?? 0),
    }))
    .filter((line) => line.lineItemId && line.quantity > 0);

  if (orderGid) {
    await recordStoreFulfillment(shop, orderGid, {
      fulfillmentId: payload?.admin_graphql_api_id ?? null,
      tracking: {
        company: payload?.tracking_company ?? "",
        number: payload?.tracking_number ?? "",
        url: payload?.tracking_url ?? "",
      },
      lines,
    });
  }

  return new Response();
};
