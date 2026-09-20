import { authenticate } from "../shopify.server";
import { removeCollection, syncCollection } from "../models/collection.server";
import { handleWebhookOnce } from "../models/webhook-event.server";

// collections/create, collections/update and collections/delete keep the saved list of
// manual collections current, so vendors only see collections that exist.
export const action = async ({ request }) => {
  const { shop, topic, payload, admin, webhookId } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  return handleWebhookOnce({ webhookId, shop, topic }, async () => {
    const collectionGid =
      payload?.admin_graphql_api_id ?? (payload?.id ? `gid://shopify/Collection/${payload.id}` : null);
    if (!collectionGid) return;

    if (topic === "COLLECTIONS_DELETE") {
      await removeCollection(shop, collectionGid);
    } else if (admin) {
      // The payload doesn't say whether it's a manual or smart collection, so ask Shopify.
      await syncCollection(admin, shop, collectionGid);
    }
  });
};
