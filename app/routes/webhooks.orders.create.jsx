import { authenticate } from "../shopify.server";
import { splitOrder } from "../models/vendor-order.server";

// Splits every new order into per-vendor orders with commission and earnings.
export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const orderGid = payload?.admin_graphql_api_id ?? (payload?.id ? `gid://shopify/Order/${payload.id}` : null);
  if (orderGid && admin) {
    const { vendorOrders } = await splitOrder(admin, shop, orderGid);
    console.log(`Split ${payload.name ?? orderGid} into ${vendorOrders} vendor orders`);
  }

  return new Response();
};
