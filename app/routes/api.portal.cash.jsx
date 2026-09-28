import crypto from "node:crypto";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { markCashCollected } from "../models/vendor-order.server";

// A vendor who ships their own cash-on-delivery order takes the money at the door, so
// they're the one who knows it arrived. Marking it paid has to happen in Shopify, which
// the portal can't reach, so it comes through here.
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
  if (!vendorOrderId || !vendorId) return Response.json({ error: "Missing order" }, { status: 400 });

  // The order has to be this vendor's, and theirs to collect on: a vendor whose orders
  // the store ships never handles the cash.
  const vendorOrder = await db.vendorOrder.findFirst({
    where: { id: vendorOrderId, vendorId, shippingMode: "VENDOR_SHIPS", cashOnDelivery: true },
    select: { id: true, shop: true },
  });
  if (!vendorOrder) return Response.json({ error: "Order not found" }, { status: 404 });

  try {
    const { admin } = await unauthenticated.admin(vendorOrder.shop);
    const result = await markCashCollected(
      admin,
      vendorOrder.shop,
      vendorOrder.id,
      `vendor:${vendorId}`,
    );
    if (result.error) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Marking cash collected failed", error);
    return Response.json({ error: "The store couldn't be reached. Try again." }, { status: 502 });
  }
};
