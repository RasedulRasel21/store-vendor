import { useEffect, useState } from "react";
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
  const requestedPage = Number.parseInt(params.get("page") ?? "1", 10);

  const { orders, counts, vendors, page } = await listVendorOrders(
    session.shop,
    { status, vendorId, query },
    Number.isFinite(requestedPage) ? requestedPage : 1,
  );
  const overdueBefore = Date.now() - OVERDUE_DAYS * 24 * 60 * 60 * 1000;

  return {
    status,
    counts,
    vendors,
    vendorId,
    query,
    page,
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
      needsAttention: order._count.issues > 0,
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
  const { status, counts, orders, vendors, vendorId, query, exportUrl, page } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const syncing = fetcher.state !== "idle";
  const result = fetcher.state === "idle" ? fetcher.data : null;
  const [exporting, setExporting] = useState(false);

  // The file is fetched from inside the admin frame, where the session token is added,
  // then handed to the browser to save. Opening the URL in a tab would have no session.
  const exportCsv = async () => {
    setExporting(true);
    try {
      const response = await fetch(exportUrl);
      if (!response.ok) throw new Error(`Export failed with ${response.status}`);

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `vendor-orders-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      shopify.toast.show("The export couldn't be created. Try again.", { isError: true });
    } finally {
      setExporting(false);
    }
  };

  // Paging keeps whatever the merchant filtered by.
  const pageHref = (number) =>
    `/app/orders?${new URLSearchParams({
      status,
      ...(vendorId ? { vendorId } : {}),
      ...(query ? { q: query } : {}),
      ...(number > 1 ? { page: String(number) } : {}),
    })}`;

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
      <s-button slot="secondary-actions" loading={exporting} onClick={exportCsv}>
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
                      {order.needsAttention && <s-badge tone="critical">Can&apos;t ship</s-badge>}
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

        {(page.hasPrevious || page.hasNext) && (
          <>
            <s-divider></s-divider>
            <s-box padding="base">
              <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                <s-text color="subdued">{`${page.from}–${page.to} of ${page.total}`}</s-text>
                <s-button-group gap="none">
                  <s-button
                    slot="secondary-actions"
                    href={pageHref(page.current - 1)}
                    disabled={!page.hasPrevious}
                    icon="chevron-left"
                    accessibilityLabel="Previous page"
                  ></s-button>
                  <s-button
                    slot="secondary-actions"
                    href={pageHref(page.current + 1)}
                    disabled={!page.hasNext}
                    icon="chevron-right"
                    accessibilityLabel="Next page"
                  ></s-button>
                </s-button-group>
              </s-stack>
            </s-box>
          </>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
