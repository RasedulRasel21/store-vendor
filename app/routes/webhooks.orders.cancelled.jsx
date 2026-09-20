import { authenticate } from "../shopify.server";
import { cancelVendorOrders } from "../models/vendor-order.server";
import { handleWebhookOnce } from "../models/webhook-event.server";

export const action = async ({ request }) => {
  const { shop, topic, payload, webhookId } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  return handleWebhookOnce({ webhookId, shop, topic }, async () => {
    const orderGid = payload?.admin_graphql_api_id ?? (payload?.id ? `gid://shopify/Order/${payload.id}` : null);
    if (orderGid) await cancelVendorOrders(shop, orderGid);
  });
};
