import crypto from "node:crypto";
import { fulfillVendorOrder } from "../models/vendor-order.server";

// The vendor portal can't call Shopify, so it asks the app to ship a vendor's lines.
// Both sides share PORTAL_SYNC_SECRET; the portal is the only caller.
function authorized(request) {
  // eslint-disable-next-line no-undef
  const secret = process.env.PORTAL_SYNC_SECRET;
  const provided = request.headers.get("x-storevendor-secret") ?? "";
  if (!secret || provided.length !== secret.length) return false;

  // eslint-disable-next-line no-undef
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
}

const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!authorized(request)) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const vendorOrderId = text(body?.vendorOrderId, 100);
  const vendorId = text(body?.vendorId, 100);
  if (!vendorOrderId || !vendorId) {
    return Response.json({ error: "Missing order details" }, { status: 400 });
  }

  // Optional: ship only some items. Quantities are checked against the order.
  const items = Array.isArray(body?.items)
    ? body.items
        .map((item) => ({
          lineId: text(item?.lineId, 100),
          quantity: Number.isInteger(item?.quantity) ? item.quantity : 0,
        }))
        .filter((item) => item.lineId)
    : [];

  const result = await fulfillVendorOrder(
    vendorOrderId,
    vendorId,
    {
      number: text(body?.trackingNumber, 100),
      company: text(body?.trackingCompany, 100),
      url: text(body?.trackingUrl, 500),
    },
    items,
  );

  return Response.json(result, { status: result.error ? 400 : 200 });
};

// Nothing to show: this endpoint is for the portal, not for people.
export const loader = () => Response.json({ error: "Not found" }, { status: 404 });
