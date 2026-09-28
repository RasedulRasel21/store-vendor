import { authenticate } from "../shopify.server";
import { privacyRequest } from "../models/privacy.server";

// The data gathered for one customer's request, as a file the merchant can send on.
export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);

  const entry = await privacyRequest(session.shop, params.id);
  if (!entry || entry.type !== "CUSTOMER_DATA" || !entry.data) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(JSON.stringify(entry.data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="customer-data-${entry.id}.json"`,
      // Somebody's name, address and phone number: never cache this anywhere.
      "Cache-Control": "no-store",
    },
  });
};
