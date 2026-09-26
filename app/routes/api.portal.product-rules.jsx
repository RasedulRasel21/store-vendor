import crypto from "node:crypto";
import db from "../db.server";
import { checkProduct } from "../models/listing-rules.server";

// The portal asks this before it accepts a product for approval, so a vendor is told what
// the store wants at the moment they try to submit, rather than finding out when it comes
// back rejected.
function authorized(request) {
  // eslint-disable-next-line no-undef
  const secret = process.env.PORTAL_SYNC_SECRET;
  const provided = request.headers.get("x-storevendor-secret") ?? "";
  if (!secret || provided.length !== secret.length) return false;

  // eslint-disable-next-line no-undef
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
}

const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!authorized(request)) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const vendorId = text(body?.vendorId, 100);
  if (!vendorId) return Response.json({ error: "Missing vendor" }, { status: 400 });

  const vendor = await db.vendor.findUnique({
    where: { id: vendorId },
    select: { id: true, shop: true, status: true },
  });
  if (!vendor || vendor.status !== "ACTIVE") {
    return Response.json({ error: "Vendor not found" }, { status: 404 });
  }

  const product = {
    title: text(body?.product?.title, 300),
    descriptionHtml: text(body?.product?.descriptionHtml, 60_000),
    productType: text(body?.product?.productType, 200),
    imageUrls: Array.isArray(body?.product?.imageUrls) ? body.product.imageUrls.slice(0, 50) : [],
  };

  const { problems } = await checkProduct(vendor.shop, vendor.id, product, {
    submissionId: text(body?.submissionId, 100) || undefined,
  });

  return Response.json({ problems });
};
