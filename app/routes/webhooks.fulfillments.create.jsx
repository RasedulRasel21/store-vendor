import { authenticate } from "../shopify.server";
import { syncFulfilledVendorOrders } from "../models/vendor-order.server";

// Keeps vendor orders in step when anyone ships lines, including the merchant in Shopify admin.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const orderGid = payload?.order_id ? `gid://shopify/Order/${payload.order_id}` : null;
  const lineItemIds = (payload?.line_items ?? [])
    .map((line) => line.admin_graphql_api_id ?? (line.id ? `gid://shopify/LineItem/${line.id}` : null))
    .filter(Boolean);

  if (orderGid) await syncFulfilledVendorOrders(shop, orderGid, lineItemIds);

  return new Response();
};
