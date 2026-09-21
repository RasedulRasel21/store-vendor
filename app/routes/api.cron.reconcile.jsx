import crypto from "node:crypto";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { syncShopLedger } from "../models/ledger.server";
import { syncRecentOrders } from "../models/vendor-order.server";
import { pruneWebhookEvents } from "../models/webhook-event.server";

// Webhooks can be missed: the app can be down, a deploy can be mid-flight, or Shopify can
// give up retrying. Once a night every shop's recent orders are read again, which fills in
// anything that never arrived and refreshes refunds and tracking on what did.
const DAYS = 7;
const ORDERS_PER_SHOP = 40;

// Vercel sends "Authorization: Bearer $CRON_SECRET" on scheduled requests when that
// variable is set. Without the variable the route stays shut, so it can't be left open.
function authorized(request) {
  // eslint-disable-next-line no-undef
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!secret || provided.length !== secret.length) return false;

  // eslint-disable-next-line no-undef
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
}

export const loader = async ({ request }) => {
  if (!authorized(request)) {
    // Nothing here as far as anyone without the secret is concerned.
    return new Response("Not found", { status: 404 });
  }

  const shops = await db.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
  });

  const results = [];
  for (const { shop } of shops) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      const synced = await syncRecentOrders(admin, shop, { days: DAYS, batchSize: ORDERS_PER_SHOP });
      // Any vendor order that changed without its ledger catching up gets caught up here.
      const ledger = await syncShopLedger(shop, {
        since: new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000),
      });
      results.push({ shop, ...synced, ledgerEntries: ledger.entries });
    } catch (error) {
      // One shop with an expired token shouldn't stop the others.
      console.error(`Nightly reconcile failed for ${shop}`, error);
      results.push({ shop, failed: true });
    }
  }

  const pruned = await pruneWebhookEvents();
  console.log(`Reconciled ${shops.length} shops, pruned ${pruned.count} webhook records`);

  return Response.json({ shops: shops.length, prunedWebhookEvents: pruned.count, results });
};
