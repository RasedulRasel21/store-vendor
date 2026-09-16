import db from "../db.server";

// Returns are read back from Shopify rather than trusted from the webhook body, so a late or
// out-of-order webhook can't leave a vendor looking at a state the store has moved on from.
const RETURN_QUERY = `#graphql
  query ReturnForVendors($id: ID!) {
    return(id: $id) {
      id
      name
      status
      order {
        id
      }
      returnLineItems(first: 100) {
        nodes {
          ... on ReturnLineItem {
            id
            quantity
            returnReason
            returnReasonNote
            fulfillmentLineItem {
              lineItem {
                id
                title
              }
            }
          }
        }
      }
    }
  }`;

// "SIZE_TOO_SMALL" reads badly in a portal; "Size too small" doesn't.
function readableReason(reason) {
  if (!reason || reason === "UNKNOWN") return null;
  const words = reason.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export async function syncReturn(admin, shop, returnGid) {
  const response = await admin.graphql(RETURN_QUERY, { variables: { id: returnGid } });
  const { data } = await response.json();
  const shopifyReturn = data?.return;
  if (!shopifyReturn?.order?.id) return { skipped: true };

  const vendorOrders = await db.vendorOrder.findMany({
    where: { shop, orderId: shopifyReturn.order.id },
    include: { lines: { select: { id: true, lineItemId: true, title: true } } },
  });
  if (!vendorOrders.length) return { skipped: true };

  const requested = shopifyReturn.returnLineItems?.nodes ?? [];

  for (const vendorOrder of vendorOrders) {
    const byLineItem = new Map(vendorOrder.lines.map((line) => [line.lineItemId, line]));
    const items = requested
      .map((item) => {
        const line = byLineItem.get(item.fulfillmentLineItem?.lineItem?.id);
        if (!line) return null;
        return {
          lineId: line.id,
          title: line.title,
          quantity: item.quantity,
          reason: readableReason(item.returnReason),
          note: item.returnReasonNote?.trim() || null,
        };
      })
      .filter(Boolean);

    // Nothing of this vendor's is coming back, so they shouldn't hear about it.
    if (!items.length) {
      await db.vendorReturn.deleteMany({ where: { vendorOrderId: vendorOrder.id, returnId: shopifyReturn.id } });
      continue;
    }

    const existing = await db.vendorReturn.findUnique({
      where: { vendorOrderId_returnId: { vendorOrderId: vendorOrder.id, returnId: shopifyReturn.id } },
      select: { status: true },
    });

    await db.vendorReturn.upsert({
      where: { vendorOrderId_returnId: { vendorOrderId: vendorOrder.id, returnId: shopifyReturn.id } },
      update: { name: shopifyReturn.name ?? null, status: shopifyReturn.status, items },
      create: {
        vendorOrderId: vendorOrder.id,
        returnId: shopifyReturn.id,
        name: shopifyReturn.name ?? null,
        status: shopifyReturn.status,
        items,
      },
    });

    if (existing?.status !== shopifyReturn.status) {
      await db.vendorActivity.create({
        data: {
          vendorId: vendorOrder.vendorId,
          action: existing ? "order.return_updated" : "order.return_requested",
          actor: "shopify",
          details: {
            orderName: vendorOrder.orderName,
            returnName: shopifyReturn.name ?? null,
            status: shopifyReturn.status,
          },
        },
      });
    }
  }

  return { ok: true };
}

export const RETURN_STATUS = {
  REQUESTED: { label: "Return requested", tone: "warning" },
  OPEN: { label: "Return approved", tone: "info" },
  DECLINED: { label: "Return declined", tone: "neutral" },
  CANCELED: { label: "Return cancelled", tone: "neutral" },
  CLOSED: { label: "Return finished", tone: "success" },
};

export function returnLabel(status) {
  return RETURN_STATUS[status]?.label ?? "Return";
}
