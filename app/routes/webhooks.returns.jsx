import { authenticate } from "../shopify.server";
import { syncReturn } from "../models/vendor-return.server";

// Every returns/* topic lands here: the return is read back from Shopify, so one handler
// covers requested, approved, declined, cancelled, reopened, processed and closed.
export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const returnGid =
    payload?.admin_graphql_api_id ?? (payload?.id ? `gid://shopify/Return/${payload.id}` : null);
  if (returnGid && admin) await syncReturn(admin, shop, returnGid);

  return new Response();
};
