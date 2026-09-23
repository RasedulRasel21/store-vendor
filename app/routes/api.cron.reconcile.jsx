import crypto from "node:crypto";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { syncShopLedger } from "../models/ledger.server";
import { issueMonthForEveryone, previousMonth } from "../models/invoice.server";
import { payEveryoneDue } from "../models/payout.server";
import { autoSend, refreshInFlight } from "../models/payout-rails.server";
import { getShopSettings } from "../models/settings.server";
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

// The job runs at 02:00 UTC, which is the start of the working day across South Asia
// and still the day before in the Americas; payout days are counted in UTC either way.
function isPayday(schedule, now = new Date()) {
  // DAILY is the threshold setting: everyone whose available balance has reached the
  // smallest payout gets paid on the next nightly run, without waiting for a set day.
  if (schedule === "DAILY") return true;
  if (schedule === "WEEKLY") return now.getUTCDay() === 1;
  if (schedule === "MONTHLY") return now.getUTCDate() === 1;
  return false;
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
      // On a payout day everyone due is set aside, ready for the merchant to send. Running
      // twice on the same day finds nothing left to set aside, so it can't double up.
      const settings = await getShopSettings(shop);
      const payday = isPayday(settings.payoutSchedule);
      const scheduled = payday ? await payEveryoneDue(shop, "schedule") : null;
      if (scheduled?.created.length) await autoSend(shop, scheduled.created.map((payout) => payout.id));
      // PayPal confirms in the background; settle whatever it has finished with.
      const rails = await refreshInFlight(shop);
      // Last month's invoices on the 1st. Each vendor and month is issued once, however
      // many times this runs.
      const invoiced =
        settings.autoInvoices && new Date().getUTCDate() === 1
          ? await issueMonthForEveryone(shop, previousMonth())
          : null;

      results.push({
        shop,
        ...synced,
        ledgerEntries: ledger.entries,
        payoutsSetAside: scheduled?.created.length ?? 0,
        invoicesIssued: invoiced?.issued.length ?? 0,
        paypalSettled: rails.settled,
      });
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
