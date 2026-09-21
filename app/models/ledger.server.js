import db from "../db.server";
import { round2 } from "../utils/money";

const DAY = 24 * 60 * 60 * 1000;

// What a vendor order should be worth to the vendor right now. A cancelled order, or one
// whose items all moved to other vendors, is worth nothing.
function owedOn(vendorOrder) {
  if (vendorOrder.status === "CANCELLED" || vendorOrder._count.lines === 0) return 0;
  return round2(Number(vendorOrder.earnings) - Number(vendorOrder.refundedEarnings));
}

// Orders change after they're placed: refunds, edits, cancellations, items moving vendor.
// Rather than every one of those remembering to post the right entry, this compares what
// the ledger says with what the order says and appends whatever closes the gap. Running it
// twice adds nothing, so it's safe to call from every place an order changes.
export async function syncOrderLedger(vendorOrderId) {
  return db.$transaction(async (tx) => {
    // Two webhooks for one order can land together; the lock makes the second wait and
    // then see the first one's entry, instead of both appending the same difference.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${vendorOrderId}))`;

    const vendorOrder = await tx.vendorOrder.findUnique({
      where: { id: vendorOrderId },
      select: {
        id: true,
        shop: true,
        vendorId: true,
        orderName: true,
        currencyCode: true,
        status: true,
        earnings: true,
        refundedEarnings: true,
        _count: { select: { lines: true } },
      },
    });
    if (!vendorOrder) return [];

    const recorded = await tx.ledgerEntry.aggregate({
      where: { vendorOrderId: vendorOrder.id },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const target = owedOn(vendorOrder);
    const entry = (type, amount, description) =>
      tx.ledgerEntry.create({
        data: {
          shop: vendorOrder.shop,
          vendorId: vendorOrder.vendorId,
          vendorOrderId: vendorOrder.id,
          orderName: vendorOrder.orderName,
          currencyCode: vendorOrder.currencyCode,
          type,
          amount: round2(amount).toFixed(2),
          description,
          createdBy: "system",
        },
      });

    const created = [];
    let current = round2(Number(recorded._sum.amount ?? 0));

    // The first time an order is seen it gets its full sale, so a statement reads
    // "sale, then refund" rather than a smaller sale nobody can explain.
    if (recorded._count._all === 0) {
      if (target === 0) return [];
      const gross = round2(vendorOrder.earnings);
      created.push(await entry("SALE", gross, `Your share of ${vendorOrder.orderName}`));
      current = gross;
    }

    const difference = round2(target - current);
    if (Math.abs(difference) < 0.005) return created;

    if (vendorOrder.status === "CANCELLED" && target === 0) {
      created.push(await entry("CANCELLATION", difference, `${vendorOrder.orderName} was cancelled`));
    } else if (difference < 0 && Number(vendorOrder.refundedEarnings) > 0) {
      created.push(await entry("REFUND", difference, `Refund on ${vendorOrder.orderName}`));
    } else {
      created.push(await entry("ADJUSTMENT", difference, `${vendorOrder.orderName} was changed`));
    }

    return created;
  }, {
    // Waiting for the lock counts against the transaction's time, and a burst of webhooks
    // for one order queues up behind it. Prisma's 5-second default is too tight for that.
    maxWait: 10_000,
    timeout: 30_000,
  });
}

// Brings every vendor order in a shop up to date. The nightly job runs it, and it doubles
// as the backfill for orders that existed before the ledger did.
export async function syncShopLedger(shop, { since } = {}) {
  const orders = await db.vendorOrder.findMany({
    where: { shop, ...(since ? { updatedAt: { gte: since } } : {}) },
    select: { id: true },
  });

  let entries = 0;
  for (const order of orders) {
    entries += (await syncOrderLedger(order.id)).length;
  }
  return { orders: orders.length, entries };
}

// When an order's share can be paid out: once the customer has paid and the items have
// gone, plus the hold. Until both have happened it isn't known, so it stays pending.
export function releasesAt(vendorOrder, holdDays) {
  if (!vendorOrder?.paidAt || !vendorOrder?.fulfilledAt) return null;
  const from = Math.max(vendorOrder.paidAt.getTime(), vendorOrder.fulfilledAt.getTime());
  return new Date(from + Math.max(0, holdDays) * DAY);
}

// Pending, available and paid for each vendor, all from the ledger.
//   pending   - order money that isn't releasable yet
//   available - everything else: released orders, manual adjustments, minus payouts.
//               Can go below zero when a refund lands after the money was paid out.
//   inFlight  - payouts set aside but not yet marked sent (already taken off available)
//   paid      - payouts actually sent, over all time
export async function vendorBalances(shop, { vendorId, holdDays }) {
  const now = Date.now();
  const where = { shop, ...(vendorId ? { vendorId } : {}) };

  const [grouped, payouts] = await Promise.all([
    db.ledgerEntry.groupBy({ by: ["vendorId", "vendorOrderId"], where, _sum: { amount: true } }),
    db.payout.groupBy({
      by: ["vendorId", "status"],
      where: { ...where, status: { in: ["PENDING", "PAID"] } },
      _sum: { amount: true },
    }),
  ]);

  const orderIds = grouped.map((row) => row.vendorOrderId).filter(Boolean);
  const orders = orderIds.length
    ? await db.vendorOrder.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, paidAt: true, fulfilledAt: true },
      })
    : [];
  const orderById = new Map(orders.map((order) => [order.id, order]));

  const balances = new Map();
  const balanceFor = (id) => {
    if (!balances.has(id)) balances.set(id, { pending: 0, available: 0, inFlight: 0, paid: 0 });
    return balances.get(id);
  };

  for (const row of grouped) {
    const amount = Number(row._sum.amount ?? 0);
    const balance = balanceFor(row.vendorId);
    const order = row.vendorOrderId ? orderById.get(row.vendorOrderId) : null;
    const release = order ? releasesAt(order, holdDays) : null;

    // An entry tied to an order waits for that order; anything else counts straight away.
    if (order && (!release || release.getTime() > now)) balance.pending += amount;
    else balance.available += amount;
  }

  for (const row of payouts) {
    const balance = balanceFor(row.vendorId);
    const amount = Number(row._sum.amount ?? 0);
    if (row.status === "PENDING") balance.inFlight += amount;
    if (row.status === "PAID") balance.paid += amount;
  }

  for (const balance of balances.values()) {
    balance.pending = round2(balance.pending);
    balance.available = round2(balance.available);
    balance.inFlight = round2(balance.inFlight);
    balance.paid = round2(balance.paid);
  }

  return balances;
}

export async function vendorBalance(shop, vendorId, holdDays) {
  const balances = await vendorBalances(shop, { vendorId, holdDays });
  return balances.get(vendorId) ?? { pending: 0, available: 0, inFlight: 0, paid: 0 };
}
