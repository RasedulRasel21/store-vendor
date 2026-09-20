import { authenticate } from "../shopify.server";
import db from "../db.server";
import { handleWebhookOnce } from "../models/webhook-event.server";

export const action = async ({ request }) => {
  const { shop, topic, payload, webhookId } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  return handleWebhookOnce({ webhookId, shop, topic }, async () => {
    // The payload carries the numeric product ID; mappings store the GID.
    if (!payload?.id) return;

    await db.vendorProduct.deleteMany({
      where: { shop, productId: `gid://shopify/Product/${payload.id}` },
    });
  });
};
