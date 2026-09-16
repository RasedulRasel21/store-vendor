import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getVendorOrder } from "../models/vendor-order.server";
import { formatMoney } from "../utils/money";
import { formatDate, VENDOR_ORDER_STATUS } from "../utils/vendor-display";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const vendorOrder = await getVendorOrder(session.shop, params.id);

  if (!vendorOrder) {
    throw new Response("Vendor order not found", { status: 404 });
  }

  const currency = vendorOrder.currencyCode;
  const address = vendorOrder.shippingAddress;

  return {
    order: {
      id: vendorOrder.id,
      orderName: vendorOrder.orderName,
      orderNumericId: vendorOrder.orderId.split("/").pop(),
      status: vendorOrder.status,
      financialStatus: vendorOrder.financialStatus,
      placedAt: formatDate(vendorOrder.placedAt),
      fulfilledAt: formatDate(vendorOrder.fulfilledAt),
      customerName: vendorOrder.customerName,
      customerEmail: vendorOrder.customerEmail,
      customerPhone: vendorOrder.customerPhone,
      address: address
        ? [
            address.name,
            address.address1,
            address.address2,
            [address.city, address.provinceCode, address.zip].filter(Boolean).join(" "),
            address.countryCode,
          ].filter(Boolean)
        : [],
      subtotal: formatMoney(vendorOrder.subtotal, currency),
      commission: formatMoney(vendorOrder.commission, currency),
      shipping: formatMoney(vendorOrder.shipping, currency),
      earnings: formatMoney(vendorOrder.earnings, currency),
      vendor: {
        id: vendorOrder.vendor.id,
        name: vendorOrder.vendor.name,
        shippingMode: vendorOrder.vendor.shippingMode,
      },
      lines: vendorOrder.lines.map((line) => ({
        id: line.id,
        title: line.title,
        variantTitle: line.variantTitle,
        sku: line.sku,
        imageUrl: line.imageUrl,
        quantity: line.quantity,
        subtotal: formatMoney(line.subtotal, currency),
        commission: formatMoney(line.commission, currency),
        earnings: formatMoney(line.earnings, currency),
      })),
    },
  };
};

export default function VendorOrderDetail() {
  const { order } = useLoaderData();
  const status = VENDOR_ORDER_STATUS[order.status];

  return (
    <s-page heading={`${order.orderName} · ${order.vendor.name}`}>
      <s-link slot="breadcrumb-actions" href="/app/orders">
        Orders
      </s-link>
      <s-button
        slot="primary-action"
        href={`shopify://admin/orders/${order.orderNumericId}`}
        target="_blank"
      >
        Open in Shopify
      </s-button>

      <s-section heading="Items">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Item</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">
              Qty
            </s-table-header>
            <s-table-header listSlot="labeled" format="currency">
              Subtotal
            </s-table-header>
            <s-table-header listSlot="labeled" format="currency">
              Commission
            </s-table-header>
            <s-table-header listSlot="labeled" format="currency">
              Vendor earns
            </s-table-header>
          </s-table-header-row>
          <s-table-body>
            {order.lines.map((line) => (
              <s-table-row key={line.id}>
                <s-table-cell>
                  <s-stack direction="inline" gap="small" alignItems="center">
                    {line.imageUrl && (
                      <s-thumbnail src={line.imageUrl} alt={line.title} size="small"></s-thumbnail>
                    )}
                    <s-stack direction="block">
                      <s-text>{line.title}</s-text>
                      {(line.variantTitle || line.sku) && (
                        <s-text color="subdued">
                          {[line.variantTitle, line.sku].filter(Boolean).join(" · ")}
                        </s-text>
                      )}
                    </s-stack>
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{String(line.quantity)}</s-table-cell>
                <s-table-cell>{line.subtotal}</s-table-cell>
                <s-table-cell>{line.commission}</s-table-cell>
                <s-table-cell>{line.earnings}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      <s-section heading="Money">
        <s-grid gridTemplateColumns="auto 1fr" gap="base">
          <s-text color="subdued">Items subtotal</s-text>
          <s-text>{order.subtotal}</s-text>
          <s-text color="subdued">Your commission</s-text>
          <s-text>{order.commission}</s-text>
          <s-text color="subdued">Shipping to vendor</s-text>
          <s-text>{order.shipping}</s-text>
          <s-text color="subdued">Vendor earns</s-text>
          <s-text type="strong">{order.earnings}</s-text>
        </s-grid>
        <s-paragraph color="subdued">
          Shipping goes to the vendor only when the whole order is theirs and they ship it
          themselves. Payouts of these earnings come next.
        </s-paragraph>
      </s-section>

      <s-section heading="Customer">
        <s-stack direction="block" gap="small">
          <s-text>{order.customerName ?? "Not provided"}</s-text>
          {order.customerEmail && <s-text color="subdued">{order.customerEmail}</s-text>}
          {order.customerPhone && <s-text color="subdued">{order.customerPhone}</s-text>}
          {order.address.length > 0 && (
            <s-text color="subdued">{order.address.join(", ")}</s-text>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Details">
        <s-stack direction="block" gap="small">
          <s-stack direction="inline">
            <s-badge tone={status.tone}>{status.label}</s-badge>
          </s-stack>
          <s-link href={`/app/vendors/${order.vendor.id}`}>{order.vendor.name}</s-link>
          <s-text color="subdued">
            {order.vendor.shippingMode === "VENDOR_SHIPS" ? "Vendor ships" : "Store ships"}
          </s-text>
          {order.financialStatus && <s-text color="subdued">{`Payment: ${order.financialStatus}`}</s-text>}
          <s-text color="subdued">{`Placed ${order.placedAt ?? "—"}`}</s-text>
          {order.fulfilledAt && <s-text color="subdued">{`Shipped ${order.fulfilledAt}`}</s-text>}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
