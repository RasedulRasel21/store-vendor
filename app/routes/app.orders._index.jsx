import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listVendorOrders, syncRecentOrders } from "../models/vendor-order.server";
import { formatMoney } from "../utils/money";
import { formatDate, VENDOR_ORDER_STATUS, VENDOR_ORDER_STATUSES } from "../utils/vendor-display";

// A vendor order still unshipped after this many days needs chasing.
const OVERDUE_DAYS = 3;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const params = new URL(request.url).searchParams;
  const requested = params.get("status");
  const status = VENDOR_ORDER_STATUSES.includes(requested) ? requested : "OPEN";
  const vendorId = params.get("vendorId") ?? "";
  const query = (params.get("q") ?? "").trim().slice(0, 100);

  const { orders, counts, vendors } = await listVendorOrders(session.shop, { status, vendorId, query });
  const overdueBefore = Date.now() - OVERDUE_DAYS * 24 * 60 * 60 * 1000;

  return {
    status,
    counts,
    vendors,
    vendorId,
    query,
    exportUrl: `/app/orders/export?${new URLSearchParams({
      status,
      ...(vendorId ? { vendorId } : {}),
      ...(query ? { q: query } : {}),
    })}`,
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
      isOverdue:
        ["OPEN", "PARTIAL"].includes(order.status) && order.placedAt.getTime() < overdueBefore,
      placedAt: formatDate(order.placedAt),
    })),
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") !== "sync") return { error: "Unknown action" };

  try {
    const result = await syncRecentOrders(admin, session.shop);
    return { ...result, error: null };
  } catch (error) {
    console.error("Order sync failed", error);
    return { error: "Orders couldn't be synced. Try again." };
  }
};

export default function Orders() {
  const { status, counts, orders, vendors, vendorId, query, exportUrl } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const syncing = fetcher.state !== "idle";
  const result = fetcher.state === "idle" ? fetcher.data : null;

  useEffect(() => {
    if (!result || result.error) return;
    const checked = `Checked ${result.checked} ${result.checked === 1 ? "order" : "orders"}`;
    const added = `added ${result.vendorOrders} vendor ${result.vendorOrders === 1 ? "order" : "orders"}`;
    shopify.toast.show(
      result.remaining ? `${checked}, ${added}. ${result.remaining} left: sync again.` : `${checked}, ${added}.`,
    );
  }, [result, shopify]);

  return (
    <s-page heading="Orders">
      <s-button
        slot="primary-action"
        loading={syncing}
        onClick={() => fetcher.submit({ intent: "sync" }, { method: "post" })}
      >
        Sync recent orders
      </s-button>
      <s-button slot="secondary-actions" href={exportUrl} download>
        Export CSV
      </s-button>

      {result?.error && (
        <s-banner tone="critical" heading="Couldn't sync orders">
          {result.error}
        </s-banner>
      )}
      <s-section padding="none">
        <s-stack direction="block" gap="base" padding="base">
          <s-stack direction="inline" gap="small">
            {VENDOR_ORDER_STATUSES.map((value) => {
              const params = new URLSearchParams({
                status: value,
                ...(vendorId ? { vendorId } : {}),
                ...(query ? { q: query } : {}),
              });
              return (
                <s-button
                  key={value}
                  variant={value === status ? "primary" : "secondary"}
                  href={`/app/orders?${params}`}
                >
                  {`${VENDOR_ORDER_STATUS[value].label} (${counts[value] ?? 0})`}
                </s-button>
              );
            })}
          </s-stack>

          <form method="get" action="/app/orders">
            <input type="hidden" name="status" value={status} />
            <s-grid gridTemplateColumns="minmax(0,1fr) minmax(0,14rem) auto" gap="base" alignItems="end">
              <s-search-field
                label="Search orders"
                name="q"
                value={query}
                placeholder="Order number, customer name or email"
              ></s-search-field>
              <s-select label="Vendor" name="vendorId" value={vendorId} placeholder="All vendors">
                <s-option value="">All vendors</s-option>
                {vendors.map((vendor) => (
                  <s-option key={vendor.id} value={vendor.id}>
                    {vendor.name}
                  </s-option>
                ))}
              </s-select>
              <s-button type="submit">Filter</s-button>
            </s-grid>
          </form>
        </s-stack>

        {orders.length === 0 ? (
          <s-box padding="base">
            <s-paragraph color="subdued">
              {status === "OPEN"
                ? "No vendor orders are waiting to ship. New orders arrive here automatically; use Sync recent orders for orders placed before you installed the app."
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
                      {order.isOverdue && <s-badge tone="critical">Overdue</s-badge>}
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
