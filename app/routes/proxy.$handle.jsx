import { authenticate } from "../shopify.server";
import { vendorPage } from "../models/storefront.server";
import { vendorStorePage } from "../models/storefront-page.server";

// yourstore.com/apps/vendors/<handle> — one seller's page. Their products aren't listed
// here: the "Shop N products" link goes to Shopify's own listing for that vendor, which
// the theme renders with its usual sorting, filtering and pagination.
export const loader = async ({ request, params }) => {
  const { liquid, session } = await authenticate.public.appProxy(request);
  if (!session) return new Response("Not found", { status: 404 });

  const vendor = await vendorPage(session.shop, params.handle);
  // A vendor who isn't active, or never existed, look the same from outside.
  if (!vendor) return new Response("Not found", { status: 404 });

  return liquid(vendorStorePage(vendor));
};
