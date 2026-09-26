import crypto from "node:crypto";
import db from "../db.server";
import { acceptAgreement, agreementOwedBy } from "../models/agreement.server";

// The agreement belongs to the store, so it's written, versioned and recorded here. The
// portal asks whether this vendor owes one, shows it, and passes back what they signed.
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

  if (intent === "owed") {
    const owed = await agreementOwedBy(vendor.shop, vendor.id);
    return Response.json({
      owed: owed ? { id: owed.id, version: owed.version, title: owed.title, body: owed.body } : null,
    });
  }

  if (intent === "accept") {
    const result = await acceptAgreement(vendor.shop, vendor.id, {
      agreementId: text(body?.agreementId, 100),
      signedName: text(body?.signedName, 200),
      vendorUserId: text(body?.vendorUserId, 100) || null,
      email: text(body?.email, 200),
      ip: text(body?.ip, 60) || null,
    });
    if (result.errors) return Response.json({ errors: result.errors }, { status: 422 });
    if (result.error) return Response.json({ error: result.error }, { status: 400 });
    return Response.json({ ok: true, version: result.version });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};
