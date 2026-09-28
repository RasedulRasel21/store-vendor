import crypto from "node:crypto";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { saveVendorZones, syncVendorShipping, vendorZones } from "../models/delivery-profile.server";
import { reportError } from "../models/error-report.server";

// A vendor's own delivery rates. They set them in the portal; putting them in front of a
// customer means writing a Shopify delivery profile, which only the app can do.
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
  const vendorId = text(body?.vendorId, 100);
  const intent = text(body?.intent, 20);
  if (!vendorId) return Response.json({ error: "Missing vendor" }, { status: 400 });

  const vendor = await db.vendor.findUnique({
    where: { id: vendorId },
    select: { id: true, shop: true, status: true },
  });
  if (!vendor || vendor.status !== "ACTIVE") {
    return Response.json({ error: "Vendor not found" }, { status: 404 });
  }

  const settings = await db.shopSettings.findUnique({
    where: { shop: vendor.shop },
    select: { vendorShippingRates: true, currencyCode: true },
  });

  if (intent === "read") {
    const zones = await vendorZones(vendor.shop, vendor.id);
    return Response.json({
      enabled: Boolean(settings?.vendorShippingRates),
      currencyCode: settings?.currencyCode ?? "USD",
      zones: zones.map((zone) => ({
        name: zone.name,
        countryCodes: zone.countryCodes,
        rates: zone.rates.map((rate) => ({
          name: rate.name,
          price: rate.price.toString(),
          transitTime: rate.transitTime ?? "",
          minOrderTotal: rate.minOrderTotal === null ? "" : rate.minOrderTotal.toString(),
          maxOrderTotal: rate.maxOrderTotal === null ? "" : rate.maxOrderTotal.toString(),
        })),
      })),
    });
  }

  if (intent === "save") {
    if (!settings?.vendorShippingRates) {
      return Response.json({ error: "This store sets the shipping itself." }, { status: 409 });
    }

    const result = await saveVendorZones(vendor.shop, vendor.id, body?.zones ?? []);
    if (result.errors) return Response.json({ errors: result.errors }, { status: 422 });

    // Saved either way; if Shopify can't be reached the rates are still here and the
    // nightly job will push them.
    try {
      const { admin } = await unauthenticated.admin(vendor.shop);
      const pushed = await syncVendorShipping(admin, vendor.shop, vendor.id);
      if (pushed.error) return Response.json({ ok: true, warning: pushed.error });
      return Response.json({ ok: true, zones: pushed.zones ?? 0, products: pushed.products ?? 0 });
    } catch (error) {
      await reportError(error, {
        context: "shipping:sync",
        shop: vendor.shop,
        vendorId: vendor.id,
      });
      return Response.json({ ok: true, warning: "Saved, but checkout hasn't been updated yet. It'll catch up." });
    }
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};
