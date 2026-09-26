import { authenticate } from "../shopify.server";
import { vendorDirectory } from "../models/storefront.server";
import { directoryPage } from "../models/storefront-page.server";

// yourstore.com/apps/vendors — everyone selling in this shop.
export const loader = async ({ request }) => {
  const { liquid, session } = await authenticate.public.appProxy(request);
  if (!session) return new Response("Not found", { status: 404 });

  const vendors = await vendorDirectory(session.shop);
  return liquid(directoryPage(vendors));
};
