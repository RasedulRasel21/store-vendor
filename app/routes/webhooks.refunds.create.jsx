import { authenticate } from "../shopify.server";
import { splitOrder } from "../models/vendor-order.server";

// Refunds are read from the order itself, because a refund can be recorded line by line,
// as an amount with no lines, or as a full refund. Splitting again reads whichever it was.
export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const orderGid = payload?.order_id ? `gid://shopify/Order/${payload.order_id}` : null;
  if (orderGid && admin) await splitOrder(admin, shop, orderGid);

  return new Response();
};
