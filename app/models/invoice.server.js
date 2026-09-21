import db from "../db.server";
import { formatMoney, round2 } from "../utils/money";
import { sendEmail } from "./email.server";

// What an invoice prints where the store hasn't filled a detail in yet. Written onto the
// invoice as it's issued, like everything else on it, so it's obvious which ones went out
// before the real details were set.
export const SELLER_PLACEHOLDER = {
  name: "Your business name (set in Settings)",
  address: "Your business address (set in Settings)",
  taxId: "Your tax number (set in Settings)",
};

const TRANSACTION = { maxWait: 10_000, timeout: 30_000 };
const monthName = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" });

export function monthBounds(year, month) {
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

export function previousMonth(now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

export function periodLabel(start) {
  return monthName.format(start);
}

// One vendor, one month. Commission is billed per order as whatever is due now minus what
// earlier invoices already billed, the same way the ledger works: an order billed last month
// and refunded this month comes through as a credit line, and nothing is billed twice.
export async function issueInvoice(shop, vendorId, { year, month }) {
  const { start, end } = monthBounds(year, month);
  if (end > new Date()) return { error: `${periodLabel(start)} isn't over yet` };

  const result = await db.$transaction(async (tx) => {
    // One store at a time, so two invoices can't take the same number.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invoice:${shop}`}))`;

    const existing = await tx.commissionInvoice.findUnique({
      where: { shop_vendorId_periodStart: { shop, vendorId, periodStart: start } },
    });
    if (existing) return { invoice: existing, existed: true };

    const [settings, vendor, orders, earlier, last] = await Promise.all([
      tx.shopSettings.findUnique({ where: { shop } }),
      tx.vendor.findFirst({
        where: { id: vendorId, shop },
        select: {
          id: true,
          name: true,
          email: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          postalCode: true,
          countryCode: true,
          taxInfo: true,
        },
      }),
      tx.vendorOrder.findMany({
        where: { shop, vendorId, placedAt: { lt: end } },
        orderBy: { placedAt: "asc" },
        select: { id: true, orderName: true, placedAt: true, status: true, commission: true, refundedCommission: true },
      }),
      tx.commissionInvoice.findMany({ where: { shop, vendorId }, select: { lines: true } }),
      tx.commissionInvoice.findFirst({ where: { shop }, orderBy: { sequence: "desc" }, select: { sequence: true } }),
    ]);
    if (!vendor) return { error: "Vendor not found" };

    const billed = new Map();
    for (const invoice of earlier) {
      for (const line of invoice.lines ?? []) {
        billed.set(line.vendorOrderId, round2((billed.get(line.vendorOrderId) ?? 0) + Number(line.amount)));
      }
    }

    const lines = [];
    for (const order of orders) {
      const due = order.status === "CANCELLED" ? 0 : round2(Number(order.commission) - Number(order.refundedCommission));
      const difference = round2(due - (billed.get(order.id) ?? 0));
      if (Math.abs(difference) < 0.005) continue;

      lines.push({
        vendorOrderId: order.id,
        orderName: order.orderName,
        date: order.placedAt.toISOString().slice(0, 10),
        description:
          difference > 0
            ? `Commission on ${order.orderName}`
            : order.status === "CANCELLED"
              ? `Credit: ${order.orderName} was cancelled`
              : `Credit: refund on ${order.orderName}`,
        amount: difference.toFixed(2),
      });
    }
    if (!lines.length) return { empty: true };

    const net = round2(lines.reduce((sum, line) => sum + Number(line.amount), 0));
    const taxRate = round2(settings?.commissionTaxRate ?? 0);
    const taxAmount = round2((net * taxRate) / 100);
    const sequence = (last?.sequence ?? 0) + 1;
    const prefix = settings?.invoicePrefix ?? "SV-";

    const invoice = await tx.commissionInvoice.create({
      data: {
        shop,
        vendorId,
        number: `${prefix}${year}-${String(sequence).padStart(4, "0")}`,
        sequence,
        periodStart: start,
        periodEnd: end,
        currencyCode: settings?.currencyCode ?? "USD",
        net: net.toFixed(2),
        taxLabel: settings?.taxLabel || "VAT",
        taxRate: taxRate.toFixed(2),
        taxAmount: taxAmount.toFixed(2),
        total: round2(net + taxAmount).toFixed(2),
        lines,
        seller: {
          name: settings?.businessName || SELLER_PLACEHOLDER.name,
          address: settings?.businessAddress || SELLER_PLACEHOLDER.address,
          taxId: settings?.businessTaxId || SELLER_PLACEHOLDER.taxId,
        },
        buyer: {
          name: vendor.taxInfo?.legalName || vendor.name,
          email: vendor.email,
          address: [vendor.addressLine1, vendor.addressLine2, [vendor.city, vendor.postalCode].filter(Boolean).join(" "), vendor.countryCode]
            .filter(Boolean)
            .join(", "),
          taxId: vendor.taxInfo?.taxIdLast4 ? `•••• ${vendor.taxInfo.taxIdLast4}` : null,
        },
      },
    });

    await tx.vendorActivity.create({
      data: { vendorId, action: "invoice.issued", actor: "system", details: { number: invoice.number } },
    });
    return { invoice };
  }, TRANSACTION);

  if (result.invoice && !result.existed) await notifyInvoice(shop, result.invoice);
  return result;
}

async function notifyInvoice(shop, invoice) {
  const vendor = await db.vendor.findUnique({ where: { id: invoice.vendorId }, select: { name: true, email: true } });
  const portal = process.env.VENDOR_PORTAL_URL?.replace(/\/$/, "");
  const credit = Number(invoice.total) < 0;

  await sendEmail(shop, {
    to: vendor?.email,
    subject: `${credit ? "Credit note" : "Commission invoice"} ${invoice.number} for ${periodLabel(invoice.periodStart)}`,
    text: [
      `Hi ${vendor?.name},`,
      credit
        ? `Here's a credit note for ${periodLabel(invoice.periodStart)}: refunds brought the commission down by ${formatMoney(-Number(invoice.total), invoice.currencyCode)}.`
        : `Here's the invoice for commission on your sales in ${periodLabel(invoice.periodStart)}: ${formatMoney(invoice.total, invoice.currencyCode)}, already taken from your earnings.`,
      "There's nothing to pay: commission comes off before your payouts.",
      portal ? `View or print it: ${portal}/earnings/invoices/${invoice.id}` : null,
      invoice.seller?.name,
    ]
      .filter(Boolean)
      .join("\n\n"),
    template: "invoice.issued",
    related: { type: "invoice", id: invoice.id },
  });
}

// Every vendor with something to bill. Vendors with nothing that month get no invoice.
export async function issueMonthForEveryone(shop, period) {
  const vendors = await db.vendor.findMany({
    where: { shop, orders: { some: {} } },
    select: { id: true, name: true },
  });

  const issued = [];
  const failed = [];
  for (const vendor of vendors) {
    const result = await issueInvoice(shop, vendor.id, period);
    if (result.invoice && !result.existed) issued.push(result.invoice.number);
    if (result.error) failed.push(`${vendor.name}: ${result.error}`);
  }
  return { issued, failed };
}

export function listInvoices(shop, { vendorId, take = 24 } = {}) {
  return db.commissionInvoice.findMany({
    where: { shop, ...(vendorId ? { vendorId } : {}) },
    orderBy: { sequence: "desc" },
    take,
    select: {
      id: true,
      number: true,
      periodStart: true,
      total: true,
      currencyCode: true,
      issuedAt: true,
      vendor: { select: { name: true } },
    },
  });
}

export function getInvoice(shop, id) {
  return db.commissionInvoice.findFirst({ where: { id, shop } });
}
