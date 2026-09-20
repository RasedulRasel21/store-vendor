import { authenticate } from "../shopify.server";
import { getShopSettings } from "../models/settings.server";
import { vendorOrdersForExport } from "../models/vendor-order.server";

const COLUMNS = [
  "Order",
  "Vendor",
  "Status",
  "Ships",
  "Payment",
  "Placed",
  "Paid",
  "Currency",
  "Items subtotal",
  "Commission",
  "Shipping to vendor",
  "Refunded",
  "Commission reversed",
  "Vendor earns",
];

// Quotes every field, so commas, quotes and line breaks in names can't break the file.
function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

const date = (value) => (value ? new Date(value).toISOString().slice(0, 10) : "");

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const params = new URL(request.url).searchParams;

  const settings = await getShopSettings(session.shop);
  const orders = await vendorOrdersForExport(session.shop, {
    status: params.get("status"),
    vendorId: params.get("vendorId") ?? undefined,
    query: params.get("q") ?? undefined,
    overdue: params.get("overdue") === "1",
    fulfillmentDays: settings.fulfillmentDays,
  });

  const rows = orders.map((order) =>
    [
      order.orderName,
      order.vendor.name,
      order.status,
      order.shippingMode === "VENDOR_SHIPS" ? "Vendor" : "Store",
      order.financialStatus ?? "",
      date(order.placedAt),
      date(order.paidAt),
      order.currencyCode,
      order.subtotal,
      order.commission,
      order.shipping,
      order.refunded,
      order.refundedCommission,
      Number(order.earnings) - Number(order.refundedEarnings),
    ]
      .map(csvCell)
      .join(","),
  );

  const csv = [COLUMNS.map(csvCell).join(","), ...rows].join("\r\n");
  const filename = `vendor-orders-${new Date().toISOString().slice(0, 10)}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
};
