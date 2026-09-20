import { authenticate } from "../shopify.server";
import { splitOrder } from "../models/vendor-order.server";
import { handleWebhookOnce } from "../models/webhook-event.server";

// Splits every new order into per-vendor orders with commission and earnings.
export const action = async ({ request }) => {
  const { shop, topic, payload, admin, webhookId } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  return handleWebhookOnce({ webhookId, shop, topic }, async () => {
    const orderGid = payload?.admin_graphql_api_id ?? (payload?.id ? `gid://shopify/Order/${payload.id}` : null);
    if (!orderGid || !admin) return;

    const { vendorOrders } = await splitOrder(admin, shop, orderGid);
    console.log(`Split ${payload.name ?? orderGid} into ${vendorOrders} vendor orders`);
  });
};
