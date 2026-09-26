import crypto from "node:crypto";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { approveProductSubmission } from "../models/product-submission.server";

// What a vendor may do, and the one permission that has to act rather than just be read:
// a trusted vendor's product going into the store without waiting to be reviewed. That
// needs Shopify, which the portal can't reach, so it happens here.
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
  const intent = text(body?.intent, 30);
  if (!vendorId) return Response.json({ error: "Missing vendor" }, { status: 400 });

  const vendor = await db.vendor.findUnique({
    where: { id: vendorId },
    select: {
      id: true,
      shop: true,
      status: true,
      canCreateProducts: true,
      autoApproveProducts: true,
      canSeeCustomerContact: true,
    },
  });
  if (!vendor || vendor.status !== "ACTIVE") {
    return Response.json({ error: "Vendor not found" }, { status: 404 });
  }

  if (intent === "permissions") {
    return Response.json({
      canCreateProducts: vendor.canCreateProducts,
      canSeeCustomerContact: vendor.canSeeCustomerContact,
      autoApproveProducts: vendor.autoApproveProducts,
    });
  }

  // Called the moment a vendor submits. A vendor without the permission is simply left
  // waiting for the merchant, which is what would have happened anyway.
  if (intent === "submitted") {
    if (!vendor.autoApproveProducts) return Response.json({ approved: false });

    const submissionId = text(body?.submissionId, 100);
    if (!submissionId) return Response.json({ error: "Missing product" }, { status: 400 });

    const submission = await db.productSubmission.findFirst({
      where: { id: submissionId, vendorId: vendor.id, shop: vendor.shop },
      select: { id: true, status: true, pendingSubmittedAt: true },
    });
    if (!submission) return Response.json({ error: "Product not found" }, { status: 404 });

    // Only a brand-new product goes through on trust. An edit to something already on
    // sale is a change to the shop's own storefront, so the merchant still sees it.
    if (submission.status !== "PENDING" || submission.pendingSubmittedAt) {
      return Response.json({ approved: false });
    }

    try {
      const { admin } = await unauthenticated.admin(vendor.shop);
      const result = await approveProductSubmission(admin, vendor.shop, submission.id, "auto-approve");
      if (result.error) {
        console.error(`Auto-approve refused for ${submission.id}: ${result.error}`);
        return Response.json({ approved: false, reason: result.error });
      }
      return Response.json({ approved: true, warning: result.warning ?? null });
    } catch (error) {
      console.error(`Auto-approve failed for ${submission.id}`, error);
      // Left waiting for the merchant, which is the safe way to fail.
      return Response.json({ approved: false });
    }
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};
