import { authenticate } from "../shopify.server";
import { vendorPage } from "../models/storefront.server";
import { unknownVendorPage, vendorStorePage } from "../models/storefront-page.server";

// yourstore.com/apps/vendors/<handle> — one seller's page. Their products aren't listed
// here: the "Shop N products" link goes to Shopify's own listing for that vendor, which
// the theme renders with its usual sorting, filtering and pagination.
export const loader = async ({ request, params }) => {
  const { liquid, session } = await authenticate.public.appProxy(request);
  // No session means the app isn't installed on this shop, so there is nothing of ours
  // to show and nothing to say about it.
  if (!session) return new Response("Not found", { status: 404 });

  const vendor = await vendorPage(session.shop, params.handle);
  // A shopper gets here by following a "Sold by" link, which the theme shows for every
  // product with a vendor name on it -- including the shop's own stock, which has nothing
  // to do with us. They followed a real link on a real shop, so they get a page with a
  // way onwards rather than the words "Not found".
  //
  // 200 rather than 404 on purpose: this is a page, not a missing one, and an app that
  // answers a shopper with a web error fails review for it.
  if (!vendor) return liquid(unknownVendorPage());

  return liquid(vendorStorePage(vendor));
};
