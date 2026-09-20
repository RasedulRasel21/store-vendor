import { authenticate } from "../shopify.server";
import { splitOrder } from "../models/vendor-order.server";
import { handleWebhookOnce } from "../models/webhook-event.server";

// Items added to or removed from an order in Shopify change what each vendor is owed,
// so the order is split again. Refunds and shipped status already recorded are kept.
export const action = async ({ request }) => {
  const { shop, topic, payload, admin, webhookId } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  return handleWebhookOnce({ webhookId, shop, topic }, async () => {
    const orderId = payload?.order_edit?.order_id ?? payload?.order_id ?? payload?.id;
    const orderGid = orderId ? `gid://shopify/Order/${orderId}` : null;
    if (!orderGid || !admin) return;

    const { vendorOrders } = await splitOrder(admin, shop, orderGid);
    console.log(`Re-split edited order into ${vendorOrders} vendor orders`);
  });
};
