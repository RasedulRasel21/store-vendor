import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listVendorOrders } from "../models/vendor-order.server";
import { formatMoney } from "../utils/money";
import { formatDate, VENDOR_ORDER_STATUS, VENDOR_ORDER_STATUSES } from "../utils/vendor-display";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const params = new URL(request.url).searchParams;
  const requested = params.get("status");
  const status = VENDOR_ORDER_STATUSES.includes(requested) ? requested : "OPEN";

  const { orders, counts } = await listVendorOrders(session.shop, {
    status,
    vendorId: params.get("vendorId") ?? undefined,
  });

  return {
    status,
    counts,
    orders: orders.map((order) => ({
      id: order.id,
      orderName: order.orderName,
      vendorName: order.vendor.name,
      vendorId: order.vendor.id,
      itemCount: order._count.lines,
      // What's actually payable: refunded items are taken back off both sides.
      earnings: formatMoney(Number(order.earnings) - Number(order.refundedEarnings), order.currencyCode),
      commission: formatMoney(
        Number(order.commission) - Number(order.refundedCommission),
        order.currencyCode,
      ),
      isRefunded: Number(order.refunded) > 0,
      status: order.status,
      placedAt: formatDate(order.placedAt),
    })),
  };
};

export default function Orders() {
  const { status, counts, orders } = useLoaderData();

  return (
    <s-page heading="Orders">
      <s-section padding="none">
        <s-stack direction="inline" gap="small" padding="base">
          {VENDOR_ORDER_STATUSES.map((value) => (
            <s-button
              key={value}
              variant={value === status ? "primary" : "secondary"}
              href={`/app/orders?status=${value}`}
            >
              {`${VENDOR_ORDER_STATUS[value].label} (${counts[value] ?? 0})`}
            </s-button>
          ))}
        </s-stack>

        {orders.length === 0 ? (
          <s-box padding="base">
            <s-paragraph color="subdued">
              {status === "OPEN"
                ? "No vendor orders are waiting to ship. When a customer buys a vendor's product, their share of the order shows up here."
                : "No vendor orders with this status."}
            </s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Order</s-table-header>
              <s-table-header listSlot="secondary">Vendor</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">
                Items
              </s-table-header>
              <s-table-header listSlot="labeled" format="currency">
                Commission
              </s-table-header>
              <s-table-header listSlot="labeled" format="currency">
                Vendor earns
              </s-table-header>
              <s-table-header listSlot="labeled">Placed</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {orders.map((order) => (
                <s-table-row key={order.id}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-link href={`/app/orders/${order.id}`}>{order.orderName}</s-link>
                      {order.isRefunded && <s-badge tone="warning">Refunded</s-badge>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{order.vendorName}</s-table-cell>
                  <s-table-cell>{String(order.itemCount)}</s-table-cell>
                  <s-table-cell>{order.commission}</s-table-cell>
                  <s-table-cell>{order.earnings}</s-table-cell>
                  <s-table-cell>{order.placedAt ?? "—"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
