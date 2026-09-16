import { authenticate } from "../shopify.server";
import { cancelVendorOrders } from "../models/vendor-order.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const orderGid = payload?.admin_graphql_api_id ?? (payload?.id ? `gid://shopify/Order/${payload.id}` : null);
  if (orderGid) await cancelVendorOrders(shop, orderGid);

  return new Response();
};
