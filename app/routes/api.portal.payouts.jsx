import crypto from "node:crypto";
import db from "../db.server";
import { holdLabel, holdOf, vendorBalance } from "../models/ledger.server";
import { payoutChangeHoldUntil, payoutMinimum } from "../models/payout.server";
import { getShopSettings } from "../models/settings.server";

// The vendor portal shows balances and lets vendors ask to be paid. The balance rules live
// here, next to the ledger, so the portal never works them out a second, different way.
function authorized(request) {
  // eslint-disable-next-line no-undef
  const secret = process.env.PORTAL_SYNC_SECRET;
  const provided = request.headers.get("x-storevendor-secret") ?? "";
  if (!secret || provided.length !== secret.length) return false;

  // eslint-disable-next-line no-undef
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
}

const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

async function summary(vendor) {
  const settings = await getShopSettings(vendor.shop);
  const [balance, openRequest] = await Promise.all([
    vendorBalance(vendor.shop, vendor.id, holdOf(settings)),
    db.payout.findFirst({
      where: { vendorId: vendor.id, status: { in: ["REQUESTED", "PENDING"] } },
      select: { id: true, status: true, amount: true },
    }),
  ]);
  const minimum = payoutMinimum(settings);
  // Paused after the vendor's own payout details changed, so money can't follow a change
  // they didn't make before they've had a chance to see it.
  const heldUntil = payoutChangeHoldUntil(settings, vendor);

  return {
    ...balance,
    payoutChangeHold: heldUntil ? heldUntil.toISOString() : null,
    currencyCode: settings.currencyCode ?? "USD",
    // A phrase like "7 days" or "1 month", so the portal doesn't have to word it itself.
    hold: holdLabel(holdOf(settings)),
    minimum,
    requestsAllowed: settings.payoutRequests,
    hasPayoutDetails: Boolean(vendor.payoutMethod),
    openPayout: openRequest ? { status: openRequest.status, amount: Number(openRequest.amount) } : null,
    canRequest:
      settings.payoutRequests &&
      Boolean(vendor.payoutMethod) &&
      !openRequest &&
      !heldUntil &&
      balance.available > 0 &&
      balance.available >= minimum,
  };
}

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
    select: { id: true, shop: true, status: true, payoutMethod: true, payoutUpdatedAt: true },
  });
  if (!vendor || vendor.status !== "ACTIVE") {
    return Response.json({ error: "Vendor not found" }, { status: 404 });
  }

  if (intent === "balance") return Response.json(await summary(vendor));

  if (intent === "request") {
    const current = await summary(vendor);
    if (!current.requestsAllowed) return Response.json({ error: "The store pays on its own schedule." }, { status: 400 });
    if (!current.hasPayoutDetails) return Response.json({ error: "Add your payout details first." }, { status: 400 });
    if (current.openPayout) return Response.json({ error: "You already have a payout on its way." }, { status: 400 });
    if (current.payoutChangeHold) {
      return Response.json(
        { error: "Your payout details changed recently, so payouts are paused for a short while. If that wasn't you, tell the store now." },
        { status: 400 },
      );
    }
    if (!current.canRequest) {
      return Response.json(
        { error: `Payouts start at ${current.minimum.toFixed(2)} ${current.currencyCode}.` },
        { status: 400 },
      );
    }

    const actor = text(body?.actor, 100) || "vendor";
    // Nothing is set aside yet: the merchant accepts, and only then does it leave the balance.
    await db.$transaction([
      db.payout.create({
        data: {
          shop: vendor.shop,
          vendorId: vendor.id,
          amount: current.available.toFixed(2),
          currencyCode: current.currencyCode,
          status: "REQUESTED",
          requestedAt: new Date(),
          createdBy: actor,
        },
      }),
      db.vendorActivity.create({
        data: {
          vendorId: vendor.id,
          action: "payout.requested",
          actor,
          details: { amount: current.available, currencyCode: current.currencyCode },
        },
      }),
    ]);

    return Response.json({ ok: true, amount: current.available, currencyCode: current.currencyCode });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};
