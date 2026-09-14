import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // The payload carries the numeric product ID; mappings store the GID.
  if (payload?.id) {
    await db.vendorProduct.deleteMany({
      where: { shop, productId: `gid://shopify/Product/${payload.id}` },
    });
  }

  return new Response();
};
