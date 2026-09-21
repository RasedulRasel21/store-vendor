import crypto from "node:crypto";
import db from "../db.server";
import { stripeOnboarding, stripeVendorStatus } from "../models/payout-rails.server";

// Stripe onboarding for vendors happens on the merchant's Stripe platform, whose key only
// the app holds. The portal asks here for the onboarding link and the account's status.
function authorized(request) {
  // eslint-disable-next-line no-undef
  const secret = process.env.PORTAL_SYNC_SECRET;
  const provided = request.headers.get("x-storevendor-secret") ?? "";
  if (!secret || provided.length !== secret.length) return false;

  // eslint-disable-next-line no-undef
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
}

// Onboarding sends the vendor back to the portal, never anywhere else.
function portalUrl(path) {
  // eslint-disable-next-line no-undef
  const base = process.env.VENDOR_PORTAL_URL?.replace(/\/$/, "");
  return base ? `${base}${path}` : null;
}

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!authorized(request)) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const vendorId = typeof body?.vendorId === "string" ? body.vendorId.slice(0, 100) : "";
  const vendor = vendorId
    ? await db.vendor.findUnique({ where: { id: vendorId }, select: { id: true, status: true } })
    : null;
  if (!vendor || vendor.status !== "ACTIVE") {
    return Response.json({ error: "Vendor not found" }, { status: 404 });
  }

  if (body?.intent === "status") return Response.json(await stripeVendorStatus(vendor.id));

  if (body?.intent === "onboard") {
    const returnUrl = portalUrl("/settings?stripe=done");
    const refreshUrl = portalUrl("/settings?stripe=retry");
    if (!returnUrl) return Response.json({ error: "VENDOR_PORTAL_URL isn't set on the store app" }, { status: 500 });

    const result = await stripeOnboarding(vendor.id, { returnUrl, refreshUrl });
    if (result.error) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ url: result.url });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};
