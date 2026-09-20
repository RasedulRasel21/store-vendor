/** @jsxImportSource preact */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

export default async () => {
  render(<VendorSplit />, document.body);
};

// A label on the left and its value on the right, the way the order summary above reads.
function Row({ label, value, strong = false }) {
  return (
    <s-stack direction="inline" justifyContent="space-between" gap="base" alignItems="center">
      {strong ? <s-text type="strong">{label}</s-text> : <s-text color="subdued">{label}</s-text>}
      {strong ? (
        <s-text type="strong" fontVariantNumeric="tabular-nums">
          {value}
        </s-text>
      ) : (
        <s-text fontVariantNumeric="tabular-nums">{value}</s-text>
      )}
    </s-stack>
  );
}

function Item({ item }) {
  return (
    <s-stack direction="inline" gap="small-200" alignItems="center">
      {item.imageUrl && <s-thumbnail src={item.imageUrl} alt={item.title} size="small"></s-thumbnail>}
      <s-stack direction="block">
        <s-text>{item.title}</s-text>
        {item.variantTitle && <s-text color="subdued">{item.variantTitle}</s-text>}
      </s-stack>
      <s-text color="subdued">{`× ${item.quantity}`}</s-text>
    </s-stack>
  );
}

function Vendor({ vendorOrder, first }) {
  return (
    <s-stack direction="block" gap="small-100">
      {!first && <s-divider></s-divider>}

      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-text type="strong">{vendorOrder.vendorName}</s-text>
        <s-badge tone={vendorOrder.tone}>{vendorOrder.statusLabel}</s-badge>
        {vendorOrder.needsAttention && <s-badge tone="critical">Can&apos;t ship</s-badge>}
        {vendorOrder.hasReturn && <s-badge tone="warning">Return</s-badge>}
        {vendorOrder.isRefunded && <s-badge tone="warning">Refunded</s-badge>}
      </s-stack>

      <s-stack direction="block" gap="small-200">
        {vendorOrder.items.map((item, index) => (
          <Item key={index} item={item} />
        ))}
        {vendorOrder.moreItems > 0 && (
          <s-text color="subdued">{`and ${vendorOrder.moreItems} more`}</s-text>
        )}
      </s-stack>

      <s-stack direction="block" gap="small-500">
        <Row label="You keep" value={vendorOrder.commission} />
        <Row label="Vendor earns" value={vendorOrder.earnings} />
        <Row label="Ships" value={vendorOrder.ships} />
      </s-stack>

      {vendorOrder.tracking.length > 0 && (
        <s-stack direction="block" gap="small-500">
          {vendorOrder.tracking.map((parcel, index) =>
            parcel.url ? (
              <s-link key={index} href={parcel.url} target="_blank">
                {parcel.label}
              </s-link>
            ) : (
              <s-text key={index} color="subdued">
                {parcel.label}
              </s-text>
            ),
          )}
        </s-stack>
      )}
    </s-stack>
  );
}

function VendorSplit() {
  const orderId = shopify.data.selected?.[0]?.id;
  const [split, setSplit] = useState(null);
  const [failed, setFailed] = useState(false);

  // The split lives in the app's database, not in Shopify, so it comes from the app
  // backend. A relative URL reaches it already authenticated.
  useEffect(() => {
    if (!orderId) return undefined;
    let live = true;

    fetch(`/api/order-split?orderId=${encodeURIComponent(orderId)}`)
      .then((response) => {
        if (!response.ok) throw new Error(`Vendor split failed with ${response.status}`);
        return response.json();
      })
      .then((data) => live && setSplit(data))
      .catch(() => live && setFailed(true));

    return () => {
      live = false;
    };
  }, [orderId]);

  // The summary is what shows while the block is collapsed, so it always says something.
  if (failed) {
    return (
      <s-admin-block heading="Vendor split" collapsedSummary="Couldn't be loaded">
        <s-banner tone="critical">
          The vendor split couldn&apos;t be loaded. Open StoreVendor to check this order.
        </s-banner>
      </s-admin-block>
    );
  }

  if (!split) {
    return (
      <s-admin-block heading="Vendor split" collapsedSummary="Loading…">
        <s-spinner accessibilityLabel="Loading the vendor split"></s-spinner>
      </s-admin-block>
    );
  }

  if (!split.vendorOrders.length) {
    return (
      <s-admin-block heading="Vendor split" collapsedSummary="No vendor items">
        <s-text color="subdued">
          Nothing in this order belongs to a vendor, so there&apos;s no commission on it.
        </s-text>
      </s-admin-block>
    );
  }

  return (
    <s-admin-block heading="Vendor split" collapsedSummary={split.summary}>
      <s-stack direction="block" gap="base">
        {split.vendorOrders.map((vendorOrder, index) => (
          <Vendor key={vendorOrder.id} vendorOrder={vendorOrder} first={index === 0} />
        ))}

        {/* Only worth totalling when the order is shared between vendors. */}
        {split.totals && split.vendorOrders.length > 1 && (
          <s-stack direction="block" gap="small-500">
            <s-divider></s-divider>
            <Row label="You keep in total" value={split.totals.commission} strong />
            <Row label="You owe the vendors" value={split.totals.earnings} strong />
          </s-stack>
        )}
      </s-stack>
    </s-admin-block>
  );
}
