import { authenticate } from "../shopify.server";
import { removeCollection, syncCollection } from "../models/collection.server";

// collections/create, collections/update and collections/delete keep the saved list of
// manual collections current, so vendors only see collections that exist.
export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const collectionGid =
    payload?.admin_graphql_api_id ?? (payload?.id ? `gid://shopify/Collection/${payload.id}` : null);
  if (!collectionGid) return new Response();

  if (topic === "COLLECTIONS_DELETE") {
    await removeCollection(shop, collectionGid);
  } else if (admin) {
    // The payload doesn't say whether it's a manual or smart collection, so ask Shopify.
    await syncCollection(admin, shop, collectionGid);
  }

  return new Response();
};
