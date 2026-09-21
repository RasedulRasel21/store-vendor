import crypto from "node:crypto";
import db from "../db.server";
import { saveVendorTaxInfo } from "../models/tax.server";

// The portal can't encrypt a tax ID itself, so vendors save their tax details through the
// app, which holds the key. Same shared secret as the other portal calls.
function authorized(request) {
  // eslint-disable-next-line no-undef
  const secret = process.env.PORTAL_SYNC_SECRET;
  const provided = request.headers.get("x-storevendor-secret") ?? "";
  if (!secret || provided.length !== secret.length) return false;

  // eslint-disable-next-line no-undef
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
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

  const actor = typeof body?.actor === "string" ? body.actor.slice(0, 100) : "vendor";
  const result = await saveVendorTaxInfo(vendor.id, body?.fields ?? {}, actor);
  if (result.errors) return Response.json({ errors: result.errors }, { status: 400 });
  if (result.error) return Response.json({ error: result.error }, { status: 400 });
  return Response.json({ ok: true });
};
