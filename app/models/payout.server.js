import db from "../db.server";
import { round2 } from "../utils/money";
import { vendorBalance, vendorBalances } from "./ledger.server";
import {
  notifyPayoutBounced,
  notifyPayoutCalledOff,
  notifyPayoutRequestAccepted,
  notifyPayoutRequestDeclined,
  notifyPayoutSent,
} from "./notifications.server";
import { getShopSettings } from "./settings.server";

// The app records payouts; it never moves money. The merchant sends it from their own
// bank or wallet, and a payout here is the record that they have, or are about to.
//
// Lifecycle:
//   REQUESTED -> PENDING   a vendor asked and the merchant accepted
//   PENDING   -> PAID      the merchant sent it and entered the reference
//   PENDING   -> CANCELLED called off before it went; the money is owed again
//   PAID      -> FAILED    the transfer bounced; the money is owed again
//
// The balance is reduced when a payout is created, not when it's marked sent, so the same
// money can't be set aside twice while a bank transfer is in progress.

const ACTIVE = ["REQUESTED", "PENDING"];

async function logPayoutActivity(tx, vendorId, action, actor, details) {
  await tx.vendorActivity.create({ data: { vendorId, action, actor, details } });
}

// Sets money aside for a vendor. With no amount it takes everything available.
async function setAside(tx, { shop, vendorId, amount, actor, payoutId, note }) {
  // One vendor at a time: two clicks on "Pay" must not both read the same balance.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payout:${vendorId}`}))`;

  const [settings, vendor] = await Promise.all([
    tx.shopSettings.findUnique({ where: { shop } }),
    tx.vendor.findFirst({
      where: { id: vendorId, shop },
      select: { id: true, name: true, payoutMethod: true, payoutDetails: true },
    }),
  ]);
  if (!vendor) return { error: "Vendor not found" };
  if (!vendor.payoutMethod) {
    return { error: `${vendor.name} hasn't added payout details yet, so there's nowhere to send it.` };
  }

  // Read inside the lock, through the same connection, so it reflects anything just set aside.
  const balance = await vendorBalance(shop, vendorId, settings?.payoutHoldDays ?? 7, tx);
  const available = round2(balance.available);
  const wanted = amount === undefined || amount === null || amount === "" ? available : round2(amount);
  const minimum = round2(settings?.payoutMinimum ?? 0);

  if (!(wanted > 0)) return { error: `${vendor.name} has nothing available to pay out.` };
  if (wanted > available) {
    return { error: `Only ${available.toFixed(2)} is available for ${vendor.name}.` };
  }
  if (wanted < minimum) {
    return { error: `Payouts start at ${minimum.toFixed(2)}; ${vendor.name} has ${available.toFixed(2)}.` };
  }

  const currencyCode = settings?.currencyCode ?? "USD";
  const data = {
    amount: wanted.toFixed(2),
    currencyCode,
    status: "PENDING",
    method: vendor.payoutMethod,
    details: vendor.payoutDetails ?? undefined,
    note: note?.trim().slice(0, 500) || undefined,
  };

  const payout = payoutId
    ? await tx.payout.update({ where: { id: payoutId }, data })
    : await tx.payout.create({ data: { ...data, shop, vendorId, createdBy: actor } });

  await tx.ledgerEntry.create({
    data: {
      shop,
      vendorId,
      payoutId: payout.id,
      currencyCode,
      type: "PAYOUT",
      amount: (-wanted).toFixed(2),
      description: "Payout",
      createdBy: actor,
    },
  });
  await logPayoutActivity(tx, vendorId, "payout.created", actor, { amount: wanted, currencyCode });

  return { payout };
}

const TRANSACTION = { maxWait: 10_000, timeout: 30_000 };

export function createPayout(shop, vendorId, { amount, actor, note } = {}) {
  return db.$transaction((tx) => setAside(tx, { shop, vendorId, amount, actor, note }), TRANSACTION);
}

// Pays every vendor whose available balance clears the minimum and who has payout details.
export async function payEveryoneDue(shop, actor) {
  const settings = await getShopSettings(shop);
  const balances = await vendorBalances(shop, { holdDays: settings.payoutHoldDays });
  const minimum = Math.max(0.01, round2(settings.payoutMinimum));

  const due = [...balances].filter(([, balance]) => balance.available >= minimum).map(([id]) => id);
  const vendors = await db.vendor.findMany({
    where: { shop, id: { in: due }, payoutMethod: { not: null } },
    select: { id: true, name: true },
  });

  const created = [];
  const skipped = [];
  for (const vendor of vendors) {
    const result = await createPayout(shop, vendor.id, { actor });
    if (result.payout) created.push(result.payout);
    else skipped.push({ vendor: vendor.name, reason: result.error });
  }
  return { created, skipped, missingDetails: due.length - vendors.length };
}

async function findPayout(tx, shop, payoutId) {
  return tx.payout.findFirst({ where: { id: payoutId, shop } });
}

// The merchant sent the money and has the bank's reference for it.
export async function markPayoutPaid(shop, payoutId, options) {
  const result = await recordPaid(shop, payoutId, options);
  // After the commit, so the vendor is never told about something that was rolled back.
  if (result.payout) await notifyPayoutSent(shop, result.payout.id);
  return result;
}

function recordPaid(shop, payoutId, { reference, actor }) {
  return db.$transaction(async (tx) => {
    const payout = await findPayout(tx, shop, payoutId);
    if (!payout) return { error: "Payout not found" };
    if (payout.status !== "PENDING") return { error: "Only a payout waiting to be sent can be marked sent" };

    const updated = await tx.payout.update({
      where: { id: payout.id },
      data: { status: "PAID", paidAt: new Date(), reference: reference?.trim().slice(0, 200) || null },
    });
    await logPayoutActivity(tx, payout.vendorId, "payout.paid", actor, {
      amount: Number(payout.amount),
      reference: updated.reference,
    });
    return { payout: updated };
  }, TRANSACTION);
}

// Called off before it went, or bounced after: either way the money is owed again, so it
// goes back on the ledger rather than the payout row being deleted.
async function giveBack(shop, payoutId, { toStatus, allowedFrom, note, actor, action }) {
  return db.$transaction(async (tx) => {
    const payout = await findPayout(tx, shop, payoutId);
    if (!payout) return { error: "Payout not found" };
    if (!allowedFrom.includes(payout.status)) return { error: "That payout can't be changed now" };

    const updated = await tx.payout.update({
      where: { id: payout.id },
      data: { status: toStatus, cancelledAt: new Date(), note: note?.trim().slice(0, 500) || payout.note },
    });

    // A request never took anything off the balance, so there's nothing to give back.
    if (payout.status !== "REQUESTED") {
      await tx.ledgerEntry.create({
        data: {
          shop,
          vendorId: payout.vendorId,
          payoutId: payout.id,
          currencyCode: payout.currencyCode,
          type: "PAYOUT_REVERSAL",
          amount: Number(payout.amount).toFixed(2),
          description: toStatus === "FAILED" ? "Payout bounced" : "Payout called off",
          createdBy: actor,
        },
      });
    }
    await logPayoutActivity(tx, payout.vendorId, action, actor, { amount: Number(payout.amount), note });
    return { payout: updated, previousStatus: payout.status };
  }, TRANSACTION);
}

export async function cancelPayout(shop, payoutId, { note, actor }) {
  const result = await giveBack(shop, payoutId, {
    toStatus: "CANCELLED",
    allowedFrom: ACTIVE,
    note,
    actor,
    action: "payout.cancelled",
  });
  // A request turned down and a payout called off read differently to the vendor.
  if (result.payout) {
    if (result.previousStatus === "REQUESTED") await notifyPayoutRequestDeclined(shop, result.payout.id);
    else await notifyPayoutCalledOff(shop, result.payout.id);
  }
  return result;
}

export async function failPayout(shop, payoutId, { note, actor }) {
  const result = await giveBack(shop, payoutId, {
    toStatus: "FAILED",
    allowedFrom: ["PAID"],
    note,
    actor,
    action: "payout.failed",
  });
  if (result.payout) await notifyPayoutBounced(shop, result.payout.id);
  return result;
}

// A vendor's request becomes a real payout. The balance may have moved since they asked,
// so it's re-checked and never pays more than is available now.
export async function acceptPayoutRequest(shop, payoutId, actor) {
  const result = await acceptRequest(shop, payoutId, actor);
  if (result.payout) await notifyPayoutRequestAccepted(shop, result.payout.id);
  return result;
}

function acceptRequest(shop, payoutId, actor) {
  return db.$transaction(async (tx) => {
    const payout = await findPayout(tx, shop, payoutId);
    if (!payout) return { error: "Request not found" };
    if (payout.status !== "REQUESTED") return { error: "That request has already been dealt with" };

    const settings = await tx.shopSettings.findUnique({ where: { shop } });
    const balance = await vendorBalance(shop, payout.vendorId, settings?.payoutHoldDays ?? 7, tx);
    const amount = Math.min(Number(payout.amount), round2(balance.available));

    return setAside(tx, { shop, vendorId: payout.vendorId, amount, actor, payoutId: payout.id });
  }, TRANSACTION);
}

export async function listPayouts(shop, { status, vendorId } = {}) {
  return db.payout.findMany({
    where: { shop, ...(status ? { status: { in: status } } : {}), ...(vendorId ? { vendorId } : {}) },
    orderBy: [{ createdAt: "desc" }],
    take: 200,
    include: { vendor: { select: { id: true, name: true } } },
  });
}

// Everyone owed money, with where to send it, for the payouts page.
export async function payoutOverview(shop) {
  const settings = await getShopSettings(shop);
  const [balances, vendors, counts] = await Promise.all([
    vendorBalances(shop, { holdDays: settings.payoutHoldDays }),
    db.vendor.findMany({
      where: { shop },
      orderBy: { name: "asc" },
      select: { id: true, name: true, status: true, payoutMethod: true },
    }),
    db.payout.groupBy({ by: ["status"], where: { shop }, _count: { _all: true }, _sum: { amount: true } }),
  ]);

  const rows = vendors
    .map((vendor) => ({
      ...vendor,
      ...(balances.get(vendor.id) ?? { pending: 0, available: 0, inFlight: 0, paid: 0 }),
    }))
    .filter((row) => row.pending || row.available || row.inFlight || row.paid);

  return {
    settings,
    rows,
    counts: Object.fromEntries(
      counts.map((row) => [row.status, { count: row._count._all, amount: Number(row._sum.amount ?? 0) }]),
    ),
  };
}
