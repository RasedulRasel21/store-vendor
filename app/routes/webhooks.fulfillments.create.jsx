import { authenticate } from "../shopify.server";
import { recordStoreFulfillment, updateShipmentTracking } from "../models/vendor-order.server";
import { handleWebhookOnce } from "../models/webhook-event.server";

// fulfillments/create and fulfillments/update both land here, so vendors see parcels the
// merchant sent, and tracking added or corrected afterwards. A parcel the portal created
// is recognised by its fulfillment id, so it isn't recorded twice.
export const action = async ({ request }) => {
  const { shop, topic, payload, admin, webhookId } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  return handleWebhookOnce({ webhookId, shop, topic }, async () => {
    const orderGid = payload?.order_id ? `gid://shopify/Order/${payload.order_id}` : null;
    const fulfillmentId =
      payload?.admin_graphql_api_id ?? (payload?.id ? `gid://shopify/Fulfillment/${payload.id}` : null);
    const tracking = {
      company: payload?.tracking_company ?? "",
      number: payload?.tracking_number ?? payload?.tracking_numbers?.[0] ?? "",
      url: payload?.tracking_url ?? payload?.tracking_urls?.[0] ?? "",
    };

    const updated = await updateShipmentTracking(shop, fulfillmentId, tracking, admin);
    if (updated || !orderGid) return;

    const lines = (payload?.line_items ?? [])
      .map((line) => ({
        lineItemId: line.admin_graphql_api_id ?? (line.id ? `gid://shopify/LineItem/${line.id}` : null),
        quantity: Number(line.quantity ?? 0),
      }))
      .filter((line) => line.lineItemId && line.quantity > 0);

    await recordStoreFulfillment(shop, orderGid, { fulfillmentId, tracking, lines, admin });
  });
};
