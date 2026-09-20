import { authenticate } from "../shopify.server";
import { vendorOrdersForShopifyOrder } from "../models/vendor-order.server";
import { formatMoney } from "../utils/money";
import { VENDOR_ORDER_STATUS } from "../utils/vendor-display";

const ORDER_GID = /^gid:\/\/shopify\/Order\/\d+$/;
const ITEMS_SHOWN = 4;

function trackingLines(shipments) {
  return shipments.map((shipment) => ({
    label: [
      [shipment.trackingCompany, shipment.trackingNumber].filter(Boolean).join(" · ") || "No tracking",
      shipment.shippedBy === "store" ? "sent by you" : "sent by the vendor",
    ].join(" — "),
    url: shipment.trackingUrl ?? null,
  }));
}

// Read by the Vendor split block on the Shopify order page. The block sends a relative
// request, so Shopify adds the session token and this resolves to the merchant's own shop.
export const loader = async ({ request }) => {
  const { session, cors } = await authenticate.admin(request);

  const orderId = new URL(request.url).searchParams.get("orderId") ?? "";
  if (!ORDER_GID.test(orderId)) {
    return cors(Response.json({ vendorOrders: [], summary: "", footer: "" }));
  }

  const vendorOrders = await vendorOrdersForShopifyOrder(session.shop, orderId);
  const currency = vendorOrders[0]?.currencyCode ?? "USD";

  // What the merchant keeps and what they owe, both after refunds.
  const commission = vendorOrders.reduce(
    (sum, order) => sum + Number(order.commission) - Number(order.refundedCommission),
    0,
  );
  const earnings = vendorOrders.reduce(
    (sum, order) => sum + Number(order.earnings) - Number(order.refundedEarnings),
    0,
  );

  return cors(
    Response.json({
      summary: vendorOrders.length
        ? `${vendorOrders.length} ${vendorOrders.length === 1 ? "vendor" : "vendors"} · you keep ${formatMoney(commission, currency)}`
        : "No vendor items",
      totals: vendorOrders.length
        ? { earnings: formatMoney(earnings, currency), commission: formatMoney(commission, currency) }
        : null,
      vendorOrders: vendorOrders.map((order) => {
        const isRefunded = Number(order.refunded) > 0;
        return {
          id: order.id,
          vendorName: order.vendor.name,
          statusLabel: VENDOR_ORDER_STATUS[order.status].label,
          tone: VENDOR_ORDER_STATUS[order.status].tone,
          needsAttention: order.issues.length > 0,
          hasReturn: order.returns.length > 0,
          isRefunded,
          items: order.lines.slice(0, ITEMS_SHOWN).map((line) => ({
            title: line.title,
            variantTitle: line.variantTitle,
            quantity: line.quantity,
            imageUrl: line.imageUrl,
          })),
          moreItems: Math.max(0, order.lines.length - ITEMS_SHOWN),
          commission: formatMoney(Number(order.commission) - Number(order.refundedCommission), currency),
          earnings: formatMoney(Number(order.earnings) - Number(order.refundedEarnings), currency),
          ships: order.shippingMode === "STORE_SHIPS" ? "You" : order.vendor.name,
          tracking: trackingLines(order.shipments),
        };
      }),
    }),
  );
};
