import crypto from "node:crypto";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { renameVendor } from "../models/vendor.server";

// A vendor changing their own shop's name. Everything else on their profile — logo,
// banner, story, policies — the portal writes itself, because none of it leaves our
// database. The name does: it goes on every one of their products in Shopify, which is
// what a customer sees as "Sold by", and only the app can write that.
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

  if (intent === "rename") {
    const { admin } = await unauthenticated.admin(vendor.shop);
    const result = await renameVendor(
      admin,
      vendor.shop,
      vendor.id,
      body?.name,
      text(body?.actor, 100) || "vendor",
    );

    if (result.errors) return Response.json({ errors: result.errors }, { status: 422 });
    if (result.error) return Response.json({ error: result.error }, { status: 400 });

    return Response.json({
      ok: true,
      // Said plainly, because a seller who renames and then sees the old name on their
      // own product page would think it hadn't worked.
      warning: result.failed
        ? `Saved, but ${result.failed} of your products still show the old name. They'll catch up.`
        : null,
    });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};
