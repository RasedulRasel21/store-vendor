import { authenticate } from "../shopify.server";
import { applyRefund } from "../models/vendor-order.server";

// A refund reverses the vendor's earnings and the store's commission on the refunded lines.
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const orderGid = payload?.order_id ? `gid://shopify/Order/${payload.order_id}` : null;
  const refundLines = (payload?.refund_line_items ?? [])
    .map((item) => ({
      lineItemId: item.line_item_id ? `gid://shopify/LineItem/${item.line_item_id}` : null,
      quantity: Number(item.quantity ?? 0),
      subtotal: Number(item.subtotal_set?.shop_money?.amount ?? item.subtotal ?? 0),
    }))
    .filter((item) => item.lineItemId && (item.quantity > 0 || item.subtotal > 0));

  if (orderGid) await applyRefund(shop, orderGid, refundLines);

  return new Response();
};
