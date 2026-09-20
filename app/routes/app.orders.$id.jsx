import { useEffect } from "react";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { reasonLabel, resolveIssue } from "../models/order-issue.server";
import db from "../db.server";
import { carrierChoices } from "../models/carrier.server";
import { getShopSettings } from "../models/settings.server";
import {
  fulfillVendorOrder,
  getVendorOrder,
  orderTimeline,
  reassignOrderLine,
} from "../models/vendor-order.server";
import { RETURN_STATUS } from "../models/vendor-return.server";
import { formatMoney } from "../utils/money";
import { formatDate, formatDateTime, VENDOR_ORDER_STATUS } from "../utils/vendor-display";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const vendorOrder = await getVendorOrder(session.shop, params.id);

  if (!vendorOrder) {
    throw new Response("Vendor order not found", { status: 404 });
  }

  const currency = vendorOrder.currencyCode;
  const address = vendorOrder.shippingAddress;

  // What's left to send decides whether the merchant can ship on the vendor's behalf.
  const remaining = vendorOrder.lines.reduce(
    (sum, line) => sum + Math.max(0, line.quantity - line.refundedQuantity - line.shippedQuantity),
    0,
  );
  const canShip = ["OPEN", "PARTIAL"].includes(vendorOrder.status) && remaining > 0;
  const [settings, carriers, otherVendors] = await Promise.all([
    getShopSettings(session.shop),
    canShip ? carrierChoices(session.shop) : null,
    db.vendor.findMany({
      where: { shop: session.shop, status: "ACTIVE", id: { not: vendorOrder.vendorId } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  // Only a line that hasn't shipped or been refunded can change hands.
  const movableLines = vendorOrder.lines
    .filter((line) => line.shippedQuantity === 0 && line.refundedQuantity < line.quantity)
    .map((line) => ({
      id: line.id,
      label: `${line.quantity} × ${[line.title, line.variantTitle].filter(Boolean).join(" · ")}`,
    }));

  // The deadline only matters while something is still waiting to go out.
  const dueAt = new Date(vendorOrder.placedAt.getTime() + settings.fulfillmentDays * 24 * 60 * 60 * 1000);
  const lateBy = Math.floor((Date.now() - dueAt.getTime()) / (24 * 60 * 60 * 1000));

  return {
    otherVendors,
    movableLines,
    due: canShip
      ? lateBy >= 0
        ? `Overdue: it was due ${formatDate(dueAt)}, ${lateBy === 0 ? "today" : `${lateBy} ${lateBy === 1 ? "day" : "days"} ago`}`
        : `Due to ship by ${formatDate(dueAt)}`
      : null,
    carriers: carriers
      ? [...new Set([...carriers.approved.map((carrier) => carrier.name), ...carriers.fromShopify])]
      : [],
    order: {
      canShip,
      remaining,
      id: vendorOrder.id,
      orderName: vendorOrder.orderName,
      orderNumericId: vendorOrder.orderId.split("/").pop(),
      status: vendorOrder.status,
      financialStatus: vendorOrder.financialStatus,
      placedAt: formatDate(vendorOrder.placedAt),
      // Only worth saying while the vendor still has something to do about it.
      accepted:
        vendorOrder.shippingMode === "STORE_SHIPS" || !["OPEN", "PARTIAL"].includes(vendorOrder.status)
          ? null
          : vendorOrder.acceptedAt
            ? `Vendor took it on ${formatDate(vendorOrder.acceptedAt)}`
            : "The vendor hasn't taken it on yet",
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
      isRefunded: Number(vendorOrder.refunded) > 0,
      refunded: formatMoney(vendorOrder.refunded, currency),
      refundedCommission: formatMoney(vendorOrder.refundedCommission, currency),
      payable: formatMoney(Number(vendorOrder.earnings) - Number(vendorOrder.refundedEarnings), currency),
      paidAt: formatDate(vendorOrder.paidAt),
      shippingMode: vendorOrder.shippingMode,
      shippingMethod: vendorOrder.shippingMethod,
      isPickup: ["PICK_UP", "RETAIL"].includes(vendorOrder.deliveryMethod ?? ""),
      customerPaid:
        vendorOrder.presentmentCurrency && vendorOrder.presentmentSubtotal
          ? formatMoney(vendorOrder.presentmentSubtotal, vendorOrder.presentmentCurrency)
          : null,
      vendor: {
        id: vendorOrder.vendor.id,
        name: vendorOrder.vendor.name,
      },
      openIssue: (() => {
        const issue = vendorOrder.issues.find((row) => row.status === "OPEN");
        if (!issue) return null;
        return {
          id: issue.id,
          reason: reasonLabel(issue.reason),
          note: issue.note,
          raisedAt: formatDate(issue.createdAt),
        };
      })(),
      returns: vendorOrder.returns.map((vendorReturn) => ({
        id: vendorReturn.id,
        name: vendorReturn.name,
        status: vendorReturn.status,
        label: RETURN_STATUS[vendorReturn.status]?.label ?? "Return",
        tone: RETURN_STATUS[vendorReturn.status]?.tone ?? "neutral",
        items: (vendorReturn.items ?? [])
          .map((item) => [`${item.quantity} × ${item.title}`, item.reason, item.note].filter(Boolean).join(" · "))
          .join("; "),
        requestedAt: formatDate(vendorReturn.requestedAt),
      })),
      timeline: orderTimeline(vendorOrder, (amount) => formatMoney(amount, currency)).map((event) => ({
        ...event,
        at: formatDateTime(event.at),
      })),
      lines: vendorOrder.lines.map((line) => ({
        id: line.id,
        title: line.title,
        variantTitle: line.variantTitle,
        sku: line.sku,
        imageUrl: line.imageUrl,
        quantity: line.quantity,
        shippedQuantity: line.shippedQuantity,
        refundedQuantity: line.refundedQuantity,
        subtotal: formatMoney(line.subtotal, currency),
        commission: formatMoney(line.commission, currency),
        earnings: formatMoney(line.earnings, currency),
      })),
    },
  };
};

export const action = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "resolveIssue") {
    const result = await resolveIssue(
      session.shop,
      String(formData.get("issueId") ?? ""),
      String(formData.get("note") ?? ""),
      "merchant",
    );
    return { intent, error: result.error ?? null };
  }

  if (intent === "moveLine") {
    const result = await reassignOrderLine(admin, session.shop, {
      vendorOrderId: params.id,
      lineId: String(formData.get("lineId") ?? ""),
      vendorId: String(formData.get("vendorId") ?? ""),
      actor: "merchant",
    });
    // Moving the last line away leaves nothing here to come back to.
    if (result.sourceGone) return redirect("/app/orders");
    return { intent, error: result.error ?? null, movedTo: result.movedTo ?? null };
  }

  if (intent === "ship") {
    // Checked against this shop first, so one merchant can't fulfill another's order.
    const vendorOrder = await getVendorOrder(session.shop, params.id);
    if (!vendorOrder) return { intent, error: "Order not found" };

    const result = await fulfillVendorOrder(
      vendorOrder.id,
      vendorOrder.vendorId,
      {
        number: String(formData.get("trackingNumber") ?? "").trim().slice(0, 100),
        company: String(formData.get("trackingCompany") ?? "").trim().slice(0, 100),
        url: String(formData.get("trackingUrl") ?? "").trim().slice(0, 500),
      },
      [],
      "store",
    );
    return { intent, error: result.error ?? null, shipped: Boolean(result.ok) };
  }

  return { intent, error: "Unknown action" };
};

export default function VendorOrderDetail() {
  const { order, carriers, movableLines, otherVendors, due } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const submittingIntent = navigation.state === "submitting" ? navigation.formData?.get("intent") : null;
  const shipping = submittingIntent === "ship";
  const status = VENDOR_ORDER_STATUS[order.status];

  useEffect(() => {
    if (actionData?.shipped) shopify.toast.show("Marked shipped, and the customer has been emailed");
    if (actionData?.movedTo) shopify.toast.show(`Moved to ${actionData.movedTo}`);
  }, [actionData, shopify]);

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

      {order.openIssue && (
        <s-banner tone="critical" heading={`${order.vendor.name} can't ship this order`}>
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {[order.openIssue.reason, order.openIssue.note].filter(Boolean).join(" — ")}
              {order.openIssue.raisedAt ? ` (${order.openIssue.raisedAt})` : ""}
            </s-paragraph>
            <s-paragraph>
              Cancel or refund the order in Shopify if that&apos;s the answer, then close this so the
              vendor knows it&apos;s been dealt with.
            </s-paragraph>
            <Form method="post">
              <input type="hidden" name="intent" value="resolveIssue" />
              <input type="hidden" name="issueId" value={order.openIssue.id} />
              <s-grid gridTemplateColumns="minmax(0,1fr) auto" gap="base" alignItems="end">
                <s-text-field
                  label="What you did"
                  name="note"
                  placeholder="Refunded the customer and cancelled the item"
                ></s-text-field>
                <s-button type="submit" variant="primary" loading={submittingIntent === "resolveIssue"}>
                  Close request
                </s-button>
              </s-grid>
            </Form>
          </s-stack>
        </s-banner>
      )}

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
                <s-table-cell>
                  {line.refundedQuantity || line.shippedQuantity
                    ? `${line.quantity} (${[
                        line.shippedQuantity ? `${line.shippedQuantity} shipped` : null,
                        line.refundedQuantity ? `${line.refundedQuantity} refunded` : null,
                      ]
                        .filter(Boolean)
                        .join(", ")})`
                    : String(line.quantity)}
                </s-table-cell>
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
          {order.isRefunded && (
            <>
              <s-text color="subdued">Refunded to customer</s-text>
              <s-text>{order.refunded}</s-text>
              <s-text color="subdued">Commission reversed</s-text>
              <s-text>{order.refundedCommission}</s-text>
            </>
          )}
          <s-text color="subdued">Vendor earns</s-text>
          <s-text type="strong">{order.isRefunded ? order.payable : order.earnings}</s-text>
          {order.customerPaid && (
            <>
              <s-text color="subdued">Customer paid</s-text>
              <s-text>{`${order.customerPaid} for these items`}</s-text>
            </>
          )}
        </s-grid>
        <s-paragraph color="subdued">
          {order.isRefunded
            ? `Before refunds the vendor earned ${order.earnings}. Refunds reverse their share and your commission on the refunded items.`
            : "Shipping goes to the vendor only when the whole order is theirs and they ship it themselves. Payouts of these earnings come next."}
        </s-paragraph>
      </s-section>

      {movableLines.length > 0 && otherVendors.length > 0 && (
        <s-section heading="Move an item to another vendor">
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              For an item sold under the wrong vendor. It moves with its money, and stays moved
              when the order is read again. Shipped and refunded items can&apos;t be moved.
            </s-paragraph>
            {actionData?.intent === "moveLine" && actionData.error && (
              <s-banner tone="critical">{actionData.error}</s-banner>
            )}
            <Form method="post">
              <input type="hidden" name="intent" value="moveLine" />
              <s-stack direction="block" gap="base">
                <s-grid gridTemplateColumns="minmax(0,1fr) minmax(0,1fr)" gap="base">
                  <s-select label="Item" name="lineId" required>
                    {movableLines.map((line) => (
                      <s-option key={line.id} value={line.id}>
                        {line.label}
                      </s-option>
                    ))}
                  </s-select>
                  <s-select label="Move to" name="vendorId" required>
                    {otherVendors.map((vendor) => (
                      <s-option key={vendor.id} value={vendor.id}>
                        {vendor.name}
                      </s-option>
                    ))}
                  </s-select>
                </s-grid>
                <s-stack direction="inline">
                  <s-button type="submit" loading={submittingIntent === "moveLine"}>
                    Move item
                  </s-button>
                </s-stack>
              </s-stack>
            </Form>
          </s-stack>
        </s-section>
      )}

      {order.canShip && (
        <s-section heading="Ship for the vendor">
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              {order.shippingMode === "STORE_SHIPS"
                ? `You ship this order. Marking it shipped here sends the customer their tracking and credits ${order.vendor.name}.`
                : `${order.vendor.name} ships this one themselves. Do it for them if they can't, and the customer gets the tracking as usual.`}
            </s-paragraph>
            {actionData?.intent === "ship" && actionData.error && (
              <s-banner tone="critical">{actionData.error}</s-banner>
            )}
            <Form method="post">
              <input type="hidden" name="intent" value="ship" />
              <s-stack direction="block" gap="base">
                <s-grid gridTemplateColumns="minmax(0,1fr) minmax(0,1fr)" gap="base">
                  <s-select label="Courier" name="trackingCompany" placeholder="No courier">
                    <s-option value="">No courier</s-option>
                    {carriers.map((carrier) => (
                      <s-option key={carrier} value={carrier}>
                        {carrier}
                      </s-option>
                    ))}
                  </s-select>
                  <s-text-field label="Tracking number" name="trackingNumber" placeholder="Optional"></s-text-field>
                </s-grid>
                <s-text-field
                  label="Tracking link"
                  name="trackingUrl"
                  placeholder="https://"
                  details="Leave empty for couriers Shopify tracks; it builds the link from the number."
                ></s-text-field>
                <s-stack direction="inline">
                  <s-button type="submit" variant="primary" loading={shipping}>
                    {`Mark ${order.remaining} ${order.remaining === 1 ? "item" : "items"} shipped`}
                  </s-button>
                </s-stack>
              </s-stack>
            </Form>
          </s-stack>
        </s-section>
      )}

      {order.returns.length > 0 && (
        <s-section heading="Returns">
          <s-stack direction="block" gap="base">
            {order.returns.map((vendorReturn) => (
              <s-stack key={vendorReturn.id} direction="block">
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-text type="strong">{vendorReturn.name ?? "Return"}</s-text>
                  <s-badge tone={vendorReturn.tone}>{vendorReturn.label}</s-badge>
                </s-stack>
                <s-text color="subdued">{vendorReturn.items}</s-text>
                <s-text color="subdued">{`Asked for ${vendorReturn.requestedAt ?? "—"}`}</s-text>
              </s-stack>
            ))}
          </s-stack>
          <s-paragraph color="subdued">
            Returns are handled in Shopify. Refunding one takes the money back off the vendor&apos;s
            earnings and your commission automatically.
          </s-paragraph>
        </s-section>
      )}

      <s-section heading="Timeline">
        <s-stack direction="block" gap="base">
          {order.timeline.map((event, index) => (
            <s-stack key={`${index}-${event.title}`} direction="block">
              <s-text type="strong">{event.title}</s-text>
              {event.description &&
                (event.link ? (
                  <s-link href={event.link} target="_blank">
                    {event.description}
                  </s-link>
                ) : (
                  <s-text color="subdued">{event.description}</s-text>
                ))}
              <s-text color="subdued">{event.at}</s-text>
            </s-stack>
          ))}
        </s-stack>
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
            {order.shippingMode === "VENDOR_SHIPS" ? "Vendor ships" : "Store ships"}
          </s-text>
          {order.isPickup ? (
            <s-text color="subdued">Customer collects from the store</s-text>
          ) : (
            order.shippingMethod && <s-text color="subdued">{`Chosen at checkout: ${order.shippingMethod}`}</s-text>
          )}
          {order.financialStatus && (
            <s-text color="subdued">
              {`Payment: ${order.financialStatus}${order.paidAt ? ` · paid ${order.paidAt}` : ""}`}
            </s-text>
          )}
          <s-text color="subdued">{`Placed ${order.placedAt ?? "—"}`}</s-text>
          {due && <s-text color="subdued">{due}</s-text>}
          {order.accepted && <s-text color="subdued">{order.accepted}</s-text>}
          {order.fulfilledAt && <s-text color="subdued">{`Shipped ${order.fulfilledAt}`}</s-text>}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
