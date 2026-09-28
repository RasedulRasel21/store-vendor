import crypto from "node:crypto";
import db from "../db.server";
import { reportError } from "../models/error-report.server";

// The portal has no database of its own for this, and two error logs to check is one too
// many, so what breaks over there is written down over here.
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
  const message = text(body?.message, 1000);
  if (!message) return Response.json({ error: "Nothing to report" }, { status: 400 });

  // A vendor id turns this into something the merchant should see on their health page.
  const vendorId = text(body?.vendorId, 100);
  const vendor = vendorId
    ? await db.vendor.findUnique({ where: { id: vendorId }, select: { id: true, shop: true } })
    : null;

  await reportError(
    { message, stack: text(body?.stack, 6000) || null },
    {
      source: "portal",
      context: text(body?.context, 200) || "portal",
      shop: vendor?.shop,
      vendorId: vendor?.id,
      details: body?.details && typeof body.details === "object" ? body.details : undefined,
    },
  );

  return Response.json({ ok: true });
};
