import crypto from "node:crypto";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { approveReturn, declineReturn, restockReturn } from "../models/vendor-return.server";

// The vendor portal has no Shopify credentials, so it asks the app to act on a return.
// Both sides share PORTAL_SYNC_SECRET, and the vendor's ownership is checked again here.
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
  const vendorReturnId = text(body?.vendorReturnId, 100);
  const vendorId = text(body?.vendorId, 100);
  const intent = text(body?.intent, 20);
  if (!vendorReturnId || !vendorId) {
    return Response.json({ error: "Missing return details" }, { status: 400 });
  }

  // The shop comes from the vendor, never from the caller.
  const vendor = await db.vendor.findUnique({ where: { id: vendorId }, select: { shop: true, status: true } });
  if (!vendor || vendor.status !== "ACTIVE") {
    return Response.json({ error: "Vendor not found" }, { status: 404 });
  }

  const { admin } = await unauthenticated.admin(vendor.shop);
  const args = { vendorReturnId, vendorId };

  let result;
  if (intent === "approve") result = await approveReturn(admin, vendor.shop, args);
  else if (intent === "decline") {
    result = await declineReturn(admin, vendor.shop, {
      ...args,
      reason: text(body?.reason, 40),
      note: text(body?.note, 500),
    });
  } else if (intent === "restock") result = await restockReturn(admin, vendor.shop, args);
  else return Response.json({ error: "Unknown action" }, { status: 400 });

  if (result.error) return Response.json({ error: result.error }, { status: 400 });
  return Response.json(result);
};
