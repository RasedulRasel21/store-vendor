import { authenticate } from "../shopify.server";
import db from "../db.server";
import { round2 } from "../utils/money";

// A year per vendor, for the merchant's accountant and for marketplace tax reporting
// (1099-K in the US, DAC7 in the EU), which fall on the merchant as the marketplace
// operator. Sales come from the orders placed that year; money moved comes from the
// ledger, so the two can be reconciled against each other.
const COLUMNS = [
  "Vendor",
  "Email",
  "Country",
  "Orders",
  "Gross sales",
  "Refunded to customers",
  "Your commission, after refunds",
  "Vendor share, after refunds",
  "Adjustments",
  "Paid out",
  "Owed at year end",
  "Currency",
];

function cell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const year = Number(new URL(request.url).searchParams.get("year"));
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return new Response("Choose a year like 2026", { status: 400 });
  }
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));

  const [vendors, orders, ledgerInYear, owedAtEnd, paidOut, settings] = await Promise.all([
    db.vendor.findMany({
      where: { shop },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, countryCode: true },
    }),
    db.vendorOrder.groupBy({
      by: ["vendorId"],
      where: { shop, placedAt: { gte: start, lt: end }, status: { not: "CANCELLED" } },
      _count: { _all: true },
      _sum: {
        subtotal: true,
        refunded: true,
        commission: true,
        refundedCommission: true,
        earnings: true,
        refundedEarnings: true,
      },
    }),
    db.ledgerEntry.groupBy({
      by: ["vendorId", "type"],
      where: { shop, createdAt: { gte: start, lt: end }, type: "ADJUSTMENT", vendorOrderId: null },
      _sum: { amount: true },
    }),
    db.ledgerEntry.groupBy({
      by: ["vendorId"],
      where: { shop, createdAt: { lt: end } },
      _sum: { amount: true },
    }),
    db.payout.groupBy({
      by: ["vendorId"],
      where: { shop, status: "PAID", paidAt: { gte: start, lt: end } },
      _sum: { amount: true },
    }),
    db.shopSettings.findUnique({ where: { shop }, select: { currencyCode: true } }),
  ]);

  const byVendor = (rows) => new Map(rows.map((row) => [row.vendorId, row]));
  const orderRows = byVendor(orders);
  const adjustments = byVendor(ledgerInYear);
  const owed = byVendor(owedAtEnd);
  const paid = byVendor(paidOut);
  const amount = (value) => round2(Number(value ?? 0)).toFixed(2);

  const rows = vendors
    .filter((vendor) => orderRows.has(vendor.id) || owed.has(vendor.id) || paid.has(vendor.id))
    .map((vendor) => {
      const sold = orderRows.get(vendor.id);
      return [
        vendor.name,
        vendor.email,
        vendor.countryCode ?? "",
        sold?._count._all ?? 0,
        amount(sold?._sum.subtotal),
        amount(sold?._sum.refunded),
        amount(Number(sold?._sum.commission ?? 0) - Number(sold?._sum.refundedCommission ?? 0)),
        amount(Number(sold?._sum.earnings ?? 0) - Number(sold?._sum.refundedEarnings ?? 0)),
        amount(adjustments.get(vendor.id)?._sum.amount),
        amount(paid.get(vendor.id)?._sum.amount),
        amount(owed.get(vendor.id)?._sum.amount),
        settings?.currencyCode ?? "",
      ]
        .map(cell)
        .join(",");
    });

  const csv = [COLUMNS.map(cell).join(","), ...rows].join("\r\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="vendor-summary-${year}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
