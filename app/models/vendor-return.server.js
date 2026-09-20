import db from "../db.server";
import { getShopSettings } from "./settings.server";

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

const APPROVE_RETURN = `#graphql
  mutation ApproveReturn($id: ID!) {
    returnApproveRequest(input: { id: $id }) {
      return { id status }
      userErrors { field message }
    }
  }`;

const DECLINE_RETURN = `#graphql
  mutation DeclineReturn($id: ID!, $reason: ReturnDeclineReason!, $note: String) {
    returnDeclineRequest(input: { id: $id, declineReason: $reason, declineNote: $note }) {
      return { id status }
      userErrors { field message }
    }
  }`;

// Everything needed to put returned stock back: which physical items came back, how many of
// each are still undisposed, and which order line they belong to so other vendors' items
// aren't touched.
const RETURN_FOR_RESTOCK = `#graphql
  query ReturnForRestock($id: ID!) {
    return(id: $id) {
      id
      status
      reverseFulfillmentOrders(first: 20) {
        nodes {
          id
          lineItems(first: 50) {
            nodes {
              id
              totalQuantity
              dispositions { quantity type }
              fulfillmentLineItem { lineItem { id } }
            }
          }
        }
      }
    }
  }`;

const RESTOCK = `#graphql
  mutation RestockReturn($dispositionInputs: [ReverseFulfillmentOrderDisposeInput!]!) {
    reverseFulfillmentOrderDispose(dispositionInputs: $dispositionInputs) {
      reverseFulfillmentOrderLineItems { id totalQuantity }
      userErrors { field message }
    }
  }`;

export const DECLINE_REASONS = ["OTHER", "FINAL_SALE", "RETURN_PERIOD_ENDED"];

// A vendor may only touch a return of their own items, on their own shop.
async function vendorReturn(shop, vendorReturnId, vendorId) {
  return db.vendorReturn.findFirst({
    where: { id: vendorReturnId, vendorOrder: { shop, vendorId } },
    include: { vendorOrder: { select: { id: true, orderId: true, orderName: true, vendorId: true } } },
  });
}

function firstError(data, key) {
  return data?.[key]?.userErrors?.[0]?.message ?? null;
}

async function logReturnActivity(vendorId, action, details) {
  await db.vendorActivity.create({ data: { vendorId, action, actor: "vendor", details } });
}

export async function approveReturn(admin, shop, { vendorReturnId, vendorId }) {
  const found = await vendorReturn(shop, vendorReturnId, vendorId);
  if (!found) return { error: "That return wasn't found" };
  if (found.status !== "REQUESTED") return { error: "That return has already been decided" };

  const response = await admin.graphql(APPROVE_RETURN, { variables: { id: found.returnId } });
  const { data } = await response.json();
  const error = firstError(data, "returnApproveRequest");
  if (error) return { error };

  await syncReturn(admin, shop, found.returnId);
  await logReturnActivity(vendorId, "return.approved", {
    orderName: found.vendorOrder.orderName,
    returnName: found.name,
  });

  return { ok: true };
}

export async function declineReturn(admin, shop, { vendorReturnId, vendorId, reason, note }) {
  const found = await vendorReturn(shop, vendorReturnId, vendorId);
  if (!found) return { error: "That return wasn't found" };
  if (found.status !== "REQUESTED") return { error: "That return has already been decided" };

  const declineReason = DECLINE_REASONS.includes(reason) ? reason : "OTHER";
  const trimmed = note?.trim().slice(0, 500) || null;
  if (declineReason === "OTHER" && !trimmed) {
    return { error: "Tell the customer why you're turning it down" };
  }

  const response = await admin.graphql(DECLINE_RETURN, {
    variables: { id: found.returnId, reason: declineReason, note: trimmed },
  });
  const { data } = await response.json();
  const error = firstError(data, "returnDeclineRequest");
  if (error) return { error };

  await syncReturn(admin, shop, found.returnId);
  await logReturnActivity(vendorId, "return.declined", {
    orderName: found.vendorOrder.orderName,
    returnName: found.name,
    reason: declineReason,
    note: trimmed,
  });

  return { ok: true };
}

// Puts the vendor's returned items back into stock at the location the merchant chose.
export async function restockReturn(admin, shop, { vendorReturnId, vendorId }) {
  const found = await vendorReturn(shop, vendorReturnId, vendorId);
  if (!found) return { error: "That return wasn't found" };
  if (found.status !== "OPEN") return { error: "Only an approved return can be restocked" };

  const settings = await getShopSettings(shop);
  if (!settings.restockLocationId) {
    return { error: "The store hasn't chosen where returns go back into stock. Ask them to set it." };
  }

  // Only the lines on this vendor's order, so a shared order can't restock someone else's items.
  const lines = await db.vendorOrderLine.findMany({
    where: { vendorOrderId: found.vendorOrder.id },
    select: { lineItemId: true },
  });
  const mine = new Set(lines.map((line) => line.lineItemId));

  const response = await admin.graphql(RETURN_FOR_RESTOCK, { variables: { id: found.returnId } });
  const { data } = await response.json();

  // Shopify refuses a single call that spans two reverse fulfillment orders, so they're
  // grouped and sent one at a time.
  const byOrder = [];
  for (const order of data?.return?.reverseFulfillmentOrders?.nodes ?? []) {
    const inputs = [];
    for (const item of order.lineItems?.nodes ?? []) {
      if (!mine.has(item.fulfillmentLineItem?.lineItem?.id)) continue;

      // Each unit can only be disposed once, so anything already handled is left alone.
      const done = (item.dispositions ?? []).reduce((sum, row) => sum + row.quantity, 0);
      const left = Math.max(0, item.totalQuantity - done);
      if (left > 0) {
        inputs.push({
          reverseFulfillmentOrderLineItemId: item.id,
          quantity: left,
          dispositionType: "RESTOCKED",
          locationId: settings.restockLocationId,
        });
      }
    }
    if (inputs.length) byOrder.push(inputs);
  }

  if (!byOrder.length) {
    return { error: "Nothing of yours is waiting to be put back. It may already be restocked." };
  }

  let units = 0;
  for (const dispositionInputs of byOrder) {
    const disposed = await admin.graphql(RESTOCK, { variables: { dispositionInputs } });
    const result = await disposed.json();
    const error = firstError(result.data, "reverseFulfillmentOrderDispose");
    // Some parcels may already be back in stock; say so rather than silently half-doing it.
    if (error) return units ? { error: `${error} ${units} already went back.` } : { error };

    units += dispositionInputs.reduce((sum, row) => sum + row.quantity, 0);
  }

  await syncReturn(admin, shop, found.returnId);
  await logReturnActivity(vendorId, "return.restocked", {
    orderName: found.vendorOrder.orderName,
    returnName: found.name,
    units,
    location: settings.restockLocationName,
  });

  return { ok: true, units, location: settings.restockLocationName };
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
