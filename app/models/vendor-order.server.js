import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { allowedCarrierNames } from "./carrier.server";
import { reasonLabel } from "./order-issue.server";
import { returnLabel } from "./vendor-return.server";
import { getShopSettings } from "./settings.server";
import { effectiveCommission } from "../utils/commission";
import { round2 } from "../utils/money";
import { VENDOR_ORDER_STATUSES } from "../utils/vendor-display";

const ORDER_FOR_SPLIT = `#graphql
  query OrderForSplit($id: ID!) {
    order(id: $id) {
      id
      name
      processedAt
      displayFinancialStatus
      currencyCode
      presentmentCurrencyCode
      taxesIncluded
      email
      phone
      totalPriceSet {
        shopMoney {
          amount
        }
      }
      totalRefundedSet {
        shopMoney {
          amount
        }
      }
      customer {
        displayName
      }
      shippingAddress {
        name
        address1
        address2
        city
        provinceCode
        zip
        countryCodeV2
        phone
      }
      shippingLine {
        title
        discountedPriceSet {
          shopMoney {
            amount
          }
        }
      }
      lineItems(first: 250) {
        nodes {
          id
          title
          variantTitle
          sku
          quantity
          requiresShipping
          originalUnitPriceSet {
            shopMoney {
              amount
            }
          }
          discountedTotalSet {
            shopMoney {
              amount
            }
            presentmentMoney {
              amount
            }
          }
          variant {
            inventoryItem {
              measurement {
                weight {
                  value
                  unit
                }
              }
            }
          }
          taxLines {
            priceSet {
              shopMoney {
                amount
              }
            }
          }
          image {
            url
          }
          product {
            id
            vendorId: metafield(namespace: "$app", key: "vendor_id") {
              value
            }
          }
        }
      }
      fulfillmentOrders(first: 50) {
        nodes {
          id
          status
          deliveryMethod {
            methodType
          }
          lineItems(first: 250) {
            nodes {
              id
              remainingQuantity
              lineItem {
                id
              }
            }
          }
        }
      }
      fulfillments(first: 50) {
        id
        trackingInfo {
          company
          number
          url
        }
      }
      refunds(first: 50) {
        id
        refundLineItems(first: 250) {
          nodes {
            quantity
            subtotalSet {
              shopMoney {
                amount
              }
            }
            lineItem {
              id
            }
          }
        }
      }
    }
  }`;

const CREATE_FULFILLMENT = `#graphql
  mutation ShipVendorLines($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }`;

// Money has been collected for these, so the vendor's earnings can be paid out.
const PAID_STATUSES = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"];

function money(node) {
  return Number(node?.shopMoney?.amount ?? 0);
}

// Products created by the app carry the vendor_id metafield; products linked by the
// merchant to an existing vendor are matched through VendorProduct as a fallback.
async function vendorIdsByProduct(shop, lineItems) {
  const byProduct = new Map();
  const unresolved = [];

  for (const line of lineItems) {
    const productId = line.product?.id;
    if (!productId || byProduct.has(productId)) continue;

    const fromMetafield = line.product?.vendorId?.value;
    if (fromMetafield) byProduct.set(productId, fromMetafield);
    else unresolved.push(productId);
  }

  if (unresolved.length) {
    const links = await db.vendorProduct.findMany({
      where: { shop, productId: { in: unresolved } },
      select: { productId: true, vendorId: true },
    });
    for (const link of links) byProduct.set(link.productId, link.vendorId);
  }

  return byProduct;
}

// What's been refunded on each line, straight from Shopify, so a re-split or a manual
// sync fixes up refunds even if the webhook was missed.
function refundsByLineItem(order) {
  const byLineItem = new Map();

  for (const refund of order.refunds ?? []) {
    for (const item of refund.refundLineItems?.nodes ?? []) {
      const lineItemId = item.lineItem?.id;
      if (!lineItemId) continue;

      const current = byLineItem.get(lineItemId) ?? { quantity: 0, subtotal: 0 };
      byLineItem.set(lineItemId, {
        quantity: current.quantity + (item.quantity ?? 0),
        subtotal: round2(current.subtotal + money(item.subtotalSet)),
      });
    }
  }

  return byLineItem;
}

// Where each line can be fulfilled from, so the vendor can ship it later.
function fulfillmentByLineItem(order) {
  const byLineItem = new Map();

  for (const fulfillmentOrder of order.fulfillmentOrders?.nodes ?? []) {
    if (["CLOSED", "CANCELLED"].includes(fulfillmentOrder.status)) continue;
    for (const item of fulfillmentOrder.lineItems?.nodes ?? []) {
      const lineItemId = item.lineItem?.id;
      if (!lineItemId || byLineItem.has(lineItemId)) continue;
      byLineItem.set(lineItemId, {
        fulfillmentOrderId: fulfillmentOrder.id,
        fulfillmentOrderLineItemId: item.id,
        fulfillableQuantity: item.remainingQuantity ?? 0,
      });
    }
  }

  return byLineItem;
}

// Splits a Shopify order into one VendorOrder per vendor, with commission and earnings.
// Safe to run again for the same order: each vendor's order is replaced.
export async function splitOrder(admin, shop, orderGid) {
  const response = await admin.graphql(ORDER_FOR_SPLIT, { variables: { id: orderGid } });
  const { data } = await response.json();
  const order = data?.order;
  if (!order) return { vendorOrders: 0 };

  const lineItems = order.lineItems?.nodes ?? [];
  const [vendorByProduct, moved] = await Promise.all([
    vendorIdsByProduct(shop, lineItems),
    // A line the merchant moved by hand beats whatever the product says.
    db.orderLineVendor.findMany({
      where: { shop, orderId: order.id },
      select: { lineItemId: true, vendorId: true },
    }),
  ]);
  const vendorByLineItem = new Map(moved.map((line) => [line.lineItemId, line.vendorId]));
  if (!vendorByProduct.size && !vendorByLineItem.size) return { vendorOrders: 0 };

  const [settings, vendors] = await Promise.all([
    getShopSettings(shop),
    db.vendor.findMany({
      where: {
        shop,
        id: { in: [...new Set([...vendorByProduct.values(), ...vendorByLineItem.values()])] },
      },
    }),
  ]);
  const vendorById = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const fulfillment = fulfillmentByLineItem(order);
  const refunds = refundsByLineItem(order);

  // Shopify records refunds in three ways: line by line, as an amount with no lines, or
  // as a full refund of the order. The last two carry no breakdown to work from.
  const totalRefunded = money(order.totalRefundedSet);
  const refundedByLine = [...refunds.values()].reduce((sum, refund) => sum + refund.subtotal, 0);
  const fullyRefunded =
    totalRefunded > 0 &&
    (order.displayFinancialStatus === "REFUNDED" || totalRefunded >= money(order.totalPriceSet));
  // What's left over covers shipping, tax or an amount refund not tied to any line.
  const unallocatedRefund = fullyRefunded ? 0 : round2(Math.max(0, totalRefunded - refundedByLine));

  // Group the order's lines by vendor and work out what each line earns.
  const groups = new Map();
  for (const line of lineItems) {
    const vendorId = vendorByLineItem.get(line.id) ?? vendorByProduct.get(line.product?.id);
    const vendor = vendorId ? vendorById.get(vendorId) : null;
    if (!vendor) continue;

    const rate = effectiveCommission(vendor, settings);
    const taxTotal = (line.taxLines ?? []).reduce((sum, tax) => sum + money(tax.priceSet), 0);
    // Tax-inclusive shops have tax inside the line total; commission is taken on the net amount.
    const subtotal = round2(money(line.discountedTotalSet) - (order.taxesIncluded ? taxTotal : 0));
    const commission = Math.min(
      subtotal,
      round2((subtotal * Number(rate.percent)) / 100 + Number(rate.fixed) * line.quantity),
    );

    // A full refund often has no line breakdown, so every line counts as refunded.
    const refund = fullyRefunded
      ? { quantity: line.quantity, subtotal }
      : refunds.get(line.id);
    const group = groups.get(vendor.id) ?? { vendor, lines: [] };
    group.lines.push({
      lineItemId: line.id,
      ...(refund
        ? {
            refundedQuantity: Math.min(line.quantity, refund.quantity),
            refundedSubtotal: Math.min(subtotal, refund.subtotal).toFixed(2),
          }
        : {}),
      title: line.title,
      variantTitle: line.variantTitle ?? null,
      sku: line.sku ?? null,
      imageUrl: line.image?.url ?? null,
      quantity: line.quantity,
      unitPrice: money(line.originalUnitPriceSet).toFixed(2),
      subtotal: subtotal.toFixed(2),
      tax: round2(taxTotal).toFixed(2),
      presentmentSubtotal: Number(line.discountedTotalSet?.presentmentMoney?.amount ?? 0).toFixed(2),
      requiresShipping: line.requiresShipping !== false,
      ...(line.variant?.inventoryItem?.measurement?.weight
        ? {
            weight: Number(line.variant.inventoryItem.measurement.weight.value ?? 0).toFixed(3),
            weightUnit: line.variant.inventoryItem.measurement.weight.unit ?? null,
          }
        : {}),
      commission: commission.toFixed(2),
      earnings: round2(subtotal - commission).toFixed(2),
      ...(fulfillment.get(line.id) ?? { fulfillableQuantity: 0 }),
    });
    groups.set(vendor.id, group);
  }

  if (!groups.size) return { vendorOrders: 0 };

  // Shipping goes to the vendor only when they ship the whole order themselves.
  const shippingTotal = money(order.shippingLine?.discountedPriceSet);
  const soleVendor = groups.size === 1 ? [...groups.values()][0].vendor : null;
  const shippingForVendor = (vendor) =>
    soleVendor && vendor.id === soleVendor.id && vendor.shippingMode === "VENDOR_SHIPS" ? shippingTotal : 0;

  const address = order.shippingAddress;
  const placedAt = new Date(order.processedAt);
  // Pickup and digital orders aren't posted, which changes what vendors are told to do.
  const deliveryMethod =
    order.fulfillmentOrders?.nodes?.find((node) => node.deliveryMethod?.methodType)?.deliveryMethod
      ?.methodType ?? null;

  for (const { vendor, lines } of groups.values()) {
    const subtotal = round2(lines.reduce((sum, line) => sum + Number(line.subtotal), 0));
    const commission = round2(lines.reduce((sum, line) => sum + Number(line.commission), 0));
    const shipping = shippingForVendor(vendor);
    const refundedItems = round2(lines.reduce((sum, line) => sum + Number(line.refundedSubtotal ?? 0), 0));
    const refundedCommission = round2(
      lines.reduce((sum, line) => {
        const refundedSubtotal = Number(line.refundedSubtotal ?? 0);
        if (!refundedSubtotal) return sum;
        const share = Number(line.subtotal) > 0 ? refundedSubtotal / Number(line.subtotal) : 1;
        return sum + Number(line.commission) * share;
      }, 0),
    );

    // Shipping credited to this vendor comes back too: fully on a full refund, and up to
    // the leftover amount when the refund wasn't broken down by line.
    const refundedShipping = fullyRefunded
      ? shipping
      : round2(Math.min(shipping, groups.size === 1 ? unallocatedRefund : 0));
    const refunded = round2(refundedItems + refundedShipping);
    const record = {
      status: orderStatus(
        lines.map((line) => ({
          quantity: line.quantity,
          refundedQuantity: Number(line.refundedQuantity ?? 0),
          shippedQuantity: 0,
        })),
        null,
      ),
      orderName: order.name,
      currencyCode: order.currencyCode,
      // Only worth keeping when the buyer paid in a different currency.
      presentmentCurrency:
        order.presentmentCurrencyCode && order.presentmentCurrencyCode !== order.currencyCode
          ? order.presentmentCurrencyCode
          : null,
      presentmentSubtotal: round2(
        lines.reduce((sum, line) => sum + Number(line.presentmentSubtotal ?? 0), 0),
      ).toFixed(2),
      deliveryMethod,
      shippingMethod: order.shippingLine?.title ?? null,
      shippingMode: vendor.shippingMode,
      financialStatus: order.displayFinancialStatus ?? null,
      customerName: order.customer?.displayName ?? address?.name ?? null,
      customerEmail: order.email ?? null,
      customerPhone: order.phone ?? address?.phone ?? null,
      shippingAddress: address
        ? {
            name: address.name ?? null,
            address1: address.address1 ?? null,
            address2: address.address2 ?? null,
            city: address.city ?? null,
            provinceCode: address.provinceCode ?? null,
            zip: address.zip ?? null,
            countryCode: address.countryCodeV2 ?? null,
            phone: address.phone ?? null,
          }
        : undefined,
      subtotal: subtotal.toFixed(2),
      commission: commission.toFixed(2),
      shipping: shipping.toFixed(2),
      earnings: round2(subtotal - commission + shipping).toFixed(2),
      refunded: refunded.toFixed(2),
      refundedCommission: refundedCommission.toFixed(2),
      refundedEarnings: round2(refundedItems - refundedCommission + refundedShipping).toFixed(2),
      placedAt,
      paidAt: PAID_STATUSES.includes(order.displayFinancialStatus) ? new Date() : null,
      refundedAt: refunded > 0 ? new Date() : null,
    };

    await db.$transaction(async (tx) => {
      const existing = await tx.vendorOrder.findUnique({
        where: { shop_orderId_vendorId: { shop, orderId: order.id, vendorId: vendor.id } },
        select: {
          id: true,
          status: true,
          paidAt: true,
          refunded: true,
          refundedAt: true,
          lines: {
            select: {
              lineItemId: true,
              refundedQuantity: true,
              refundedSubtotal: true,
              shippedQuantity: true,
            },
          },
        },
      });

      if (existing) {
        // A refund that grew since the last read is a new refund, and worth a timestamp.
        const refundGrew = refunded > Number(existing.refunded);

        // Lines are rebuilt from Shopify, which knows the refunds; what it doesn't know is
        // how much of each line we've already put in a parcel, so that's carried over.
        const shippedByLine = new Map(
          existing.lines.map((line) => [line.lineItemId, line.shippedQuantity]),
        );
        const keptLines = lines.map((line) => ({
          ...line,
          shippedQuantity: Math.min(line.quantity, shippedByLine.get(line.lineItemId) ?? 0),
        }));

        await tx.vendorOrderLine.deleteMany({ where: { vendorOrderId: existing.id } });
        await tx.vendorOrder.update({
          where: { id: existing.id },
          data: {
            ...record,
            // Refunds and shipments can both move an order on; cancelled stays cancelled.
            status: orderStatus(
              keptLines.map((line) => ({
                quantity: line.quantity,
                refundedQuantity: Number(line.refundedQuantity ?? 0),
                shippedQuantity: Number(line.shippedQuantity ?? 0),
              })),
              existing.status,
            ),
            paidAt: existing.paidAt ?? record.paidAt,
            refundedAt: refunded > 0 ? (refundGrew ? new Date() : existing.refundedAt) : null,
            lines: { create: keptLines },
          },
        });

        if (refundGrew) {
          await tx.vendorActivity.create({
            data: {
              vendorId: vendor.id,
              action: "order.refunded",
              actor: "shopify",
              details: { orderName: order.name, refunded: record.refunded },
            },
          });
        }
        return;
      }

      await tx.vendorOrder.create({
        data: { shop, vendorId: vendor.id, orderId: order.id, ...record, lines: { create: lines } },
      });
      await tx.vendorActivity.create({
        data: {
          vendorId: vendor.id,
          action: "order.received",
          actor: "shopify",
          details: { orderName: order.name, earnings: record.earnings },
        },
      });
    });
  }

  await refreshShipmentTracking(order);

  return { vendorOrders: groups.size };
}

// Tracking can be added in Shopify after a parcel was recorded, so a re-read fixes it up.
async function refreshShipmentTracking(order) {
  for (const fulfillment of order.fulfillments ?? []) {
    const info = fulfillment.trackingInfo?.[0];
    if (!info) continue;

    await db.vendorShipment.updateMany({
      where: { fulfillmentId: fulfillment.id },
      data: {
        trackingCompany: info.company || null,
        trackingNumber: info.number || null,
        trackingUrl: info.url || null,
      },
    });
  }
}

const RECENT_ORDERS = `#graphql
  query RecentOrders($query: String!, $cursor: String) {
    orders(first: 100, after: $cursor, sortKey: CREATED_AT, reverse: true, query: $query) {
      nodes {
        id
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

// Orders placed before the app was installed never arrive by webhook, and an order can drift
// out of date if a webhook was missed. This reads recent orders again, newest first: missing
// ones first, then ones already split, so refunds and edits are picked up either way.
export async function syncRecentOrders(admin, shop, { days = 60, batchSize = 20 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const query = `created_at:>=${since}`;

  const missing = [];
  const known = [];
  let cursor = null;
  // Look through up to 500 recent orders.
  for (let page = 0; page < 5; page++) {
    const response = await admin.graphql(RECENT_ORDERS, { variables: { query, cursor } });
    const { data } = await response.json();
    const orders = data?.orders;
    if (!orders) break;

    const ids = orders.nodes.map((order) => order.id);
    const stored = await db.vendorOrder.findMany({
      where: { shop, orderId: { in: ids } },
      select: { orderId: true },
      distinct: ["orderId"],
    });
    const storedIds = new Set(stored.map((row) => row.orderId));
    for (const id of ids) (storedIds.has(id) ? known : missing).push(id);

    cursor = orders.pageInfo.hasNextPage ? orders.pageInfo.endCursor : null;
    if (!cursor || missing.length + known.length >= batchSize * 5) break;
  }

  const candidates = [...missing, ...known];
  const batch = candidates.slice(0, batchSize);
  let vendorOrders = 0;
  for (const orderId of batch) {
    const result = await splitOrder(admin, shop, orderId);
    vendorOrders += result.vendorOrders;
  }

  return {
    checked: batch.length,
    vendorOrders,
    remaining: Math.max(0, candidates.length - batch.length),
    days,
  };
}

// Keeps payment status current, including cash on delivery marked paid days later.
export async function updatePaymentStatus(shop, orderGid, financialStatus) {
  if (!financialStatus) return;

  const paid = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(financialStatus);
  await db.vendorOrder.updateMany({
    where: { shop, orderId: orderGid },
    data: {
      financialStatus,
      ...(paid ? { paidAt: new Date() } : {}),
    },
  });
}

export async function cancelVendorOrders(shop, orderGid) {
  await db.vendorOrder.updateMany({
    where: { shop, orderId: orderGid, status: { not: "CANCELLED" } },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
}

// Where a vendor order stands: everything refunded, fully shipped, partly shipped, or
// still to ship. Refunded items don't need shipping. A cancelled order stays cancelled.
function orderStatus(lines, currentStatus) {
  if (currentStatus === "CANCELLED") return "CANCELLED";

  const ordered = lines.reduce((sum, line) => sum + line.quantity, 0);
  const refunded = lines.reduce((sum, line) => sum + (line.refundedQuantity ?? 0), 0);
  if (ordered > 0 && refunded >= ordered) return "REFUNDED";

  const outstanding = lines.reduce(
    (sum, line) => sum + Math.max(0, line.quantity - (line.refundedQuantity ?? 0) - (line.shippedQuantity ?? 0)),
    0,
  );
  const shipped = lines.reduce((sum, line) => sum + (line.shippedQuantity ?? 0), 0);

  if (outstanding === 0) return "FULFILLED";
  return shipped > 0 ? "PARTIAL" : "OPEN";
}

// Records one parcel against a vendor order and moves the order's status on.
async function saveShipment(vendorOrder, { fulfillmentId, tracking, items, shippedBy }) {
  const byLineId = new Map(items.map((item) => [item.lineId, item.quantity]));
  const updatedLines = vendorOrder.lines.map((line) => {
    const quantity = byLineId.get(line.id) ?? 0;
    return { ...line, shippedQuantity: Math.min(line.quantity, line.shippedQuantity + quantity) };
  });
  const status = orderStatus(updatedLines, vendorOrder.status);

  await db.$transaction([
    ...updatedLines
      .filter((line) => byLineId.get(line.id))
      .map((line) =>
        db.vendorOrderLine.update({
          where: { id: line.id },
          data: { shippedQuantity: line.shippedQuantity },
        }),
      ),
    db.vendorShipment.create({
      data: {
        vendorOrderId: vendorOrder.id,
        fulfillmentId: fulfillmentId ?? null,
        trackingCompany: tracking.company || null,
        trackingNumber: tracking.number || null,
        trackingUrl: tracking.url || null,
        items: items.map((item) => ({
          lineId: item.lineId,
          title: vendorOrder.lines.find((line) => line.id === item.lineId)?.title ?? "",
          quantity: item.quantity,
        })),
        shippedBy,
      },
    }),
    db.vendorOrder.update({
      where: { id: vendorOrder.id },
      data: {
        status,
        fulfilledAt: status === "FULFILLED" ? new Date() : null,
      },
    }),
  ]);

  return status;
}

const FULFILLMENT_TRACKING = `#graphql
  query FulfillmentTracking($id: ID!) {
    fulfillment(id: $id) {
      id
      trackingInfo {
        company
        number
        url
      }
    }
  }`;

// Webhook payloads don't always carry tracking, so it's read back from Shopify.
async function trackingFromShopify(admin, fulfillmentId) {
  if (!admin || !fulfillmentId) return null;

  try {
    const response = await admin.graphql(FULFILLMENT_TRACKING, { variables: { id: fulfillmentId } });
    const { data } = await response.json();
    const info = data?.fulfillment?.trackingInfo?.[0];
    if (!info) return null;

    return { company: info.company ?? "", number: info.number ?? "", url: info.url ?? "" };
  } catch (error) {
    console.error("Couldn't read fulfillment tracking", error);
    return null;
  }
}

// Tracking added or corrected in Shopify after the parcel was created.
export async function updateShipmentTracking(shop, fulfillmentId, tracking, admin) {
  if (!fulfillmentId) return false;

  const shipment = await db.vendorShipment.findFirst({ where: { fulfillmentId }, select: { id: true } });
  if (!shipment) return false;

  const info = (await trackingFromShopify(admin, fulfillmentId)) ?? tracking;
  await db.vendorShipment.update({
    where: { id: shipment.id },
    data: {
      trackingCompany: info.company || null,
      trackingNumber: info.number || null,
      trackingUrl: info.url || null,
    },
  });

  return true;
}

// Shipments made in Shopify admin, or by anyone else, keep vendor orders in step.
// A shipment the portal just created arrives here too, and is ignored by its fulfillment id.
export async function recordStoreFulfillment(shop, orderGid, { fulfillmentId, tracking, lines, admin }) {
  if (!lines.length) return;

  if (fulfillmentId) {
    const known = await db.vendorShipment.findFirst({ where: { fulfillmentId }, select: { id: true } });
    if (known) return;
  }

  const info = (await trackingFromShopify(admin, fulfillmentId)) ?? tracking;

  const vendorOrders = await db.vendorOrder.findMany({
    where: { shop, orderId: orderGid, status: { in: ["OPEN", "PARTIAL"] } },
    include: { lines: true },
  });

  for (const vendorOrder of vendorOrders) {
    const items = vendorOrder.lines
      .map((line) => {
        const shipped = lines
          .filter((item) => item.lineItemId === line.lineItemId)
          .reduce((sum, item) => sum + item.quantity, 0);
        const room = Math.max(0, line.quantity - line.shippedQuantity);
        return { lineId: line.id, quantity: Math.min(room, shipped) };
      })
      .filter((item) => item.quantity > 0);

    if (!items.length) continue;
    await saveShipment(vendorOrder, { fulfillmentId, tracking: info, items, shippedBy: "store" });
  }
}

// Ships a vendor's lines in Shopify. Called by the vendor portal through /api/portal/fulfill,
// because the portal has no Shopify access of its own.
// actor is "vendor" when this comes from the portal, or "store" when the merchant ships on a
// vendor's behalf: the merchant can ship either way, a vendor only their own orders.
export async function fulfillVendorOrder(
  vendorOrderId,
  vendorId,
  tracking,
  requestedItems = [],
  actor = "vendor",
) {
  const byStore = actor === "store";
  const vendorOrder = await db.vendorOrder.findFirst({
    where: { id: vendorOrderId, vendorId },
    include: { lines: true },
  });
  if (!vendorOrder) return { error: "Order not found" };
  if (vendorOrder.status === "CANCELLED") return { error: "This order was cancelled" };
  if (vendorOrder.status === "FULFILLED") return { error: "This order is already marked shipped" };
  if (!byStore && vendorOrder.shippingMode === "STORE_SHIPS") {
    return { error: "The store ships this order, so it can't be shipped from the portal." };
  }

  // What's left to send on each line: refunded items don't ship, and neither do items
  // already in an earlier parcel.
  const remainingByLine = new Map(
    vendorOrder.lines.map((line) => [
      line.id,
      Math.max(0, line.quantity - line.refundedQuantity - line.shippedQuantity),
    ]),
  );

  // Ship everything that's left unless the vendor picked quantities.
  const items = requestedItems.length
    ? requestedItems.map((item) => ({ lineId: item.lineId, quantity: item.quantity }))
    : vendorOrder.lines.map((line) => ({ lineId: line.id, quantity: remainingByLine.get(line.id) ?? 0 }));

  const shipping = [];
  for (const item of items) {
    const line = vendorOrder.lines.find((candidate) => candidate.id === item.lineId);
    if (!line) return { error: "Those items aren't part of this order" };

    const remaining = remainingByLine.get(line.id) ?? 0;
    if (item.quantity < 0 || item.quantity > remaining) {
      return { error: `You can ship up to ${remaining} of "${line.title}"` };
    }
    if (item.quantity > 0) shipping.push({ line, quantity: item.quantity });
  }

  if (!shipping.length) return { error: "Choose at least one item to ship" };

  // Only carriers this shop allows, so tracking links keep working and the data stays clean.
  if (tracking.company) {
    const allowed = await allowedCarrierNames(vendorOrder.shop);
    if (!allowed.has(tracking.company.toLowerCase())) {
      return {
        error: byStore
          ? `${tracking.company} isn't on your courier list. Add it in Settings first.`
          : `${tracking.company} isn't on the store's courier list. Ask the store to add it.`,
      };
    }
  }

  // Shopify groups the lines to ship by fulfillment order.
  const byFulfillmentOrder = new Map();
  for (const { line, quantity } of shipping) {
    if (!line.fulfillmentOrderId || !line.fulfillmentOrderLineItemId) continue;
    const lineItems = byFulfillmentOrder.get(line.fulfillmentOrderId) ?? [];
    lineItems.push({ id: line.fulfillmentOrderLineItemId, quantity });
    byFulfillmentOrder.set(line.fulfillmentOrderId, lineItems);
  }
  if (!byFulfillmentOrder.size) {
    return { error: "These items can't be shipped from here. The store may have shipped them already." };
  }

  const trackingInfo = {
    ...(tracking.number ? { number: tracking.number } : {}),
    ...(tracking.company ? { company: tracking.company } : {}),
    ...(tracking.url ? { url: tracking.url } : {}),
  };

  const { admin } = await unauthenticated.admin(vendorOrder.shop);
  const response = await admin.graphql(CREATE_FULFILLMENT, {
    variables: {
      fulfillment: {
        lineItemsByFulfillmentOrder: [...byFulfillmentOrder].map(([fulfillmentOrderId, fulfillmentOrderLineItems]) => ({
          fulfillmentOrderId,
          fulfillmentOrderLineItems,
        })),
        ...(Object.keys(trackingInfo).length ? { trackingInfo } : {}),
        notifyCustomer: true,
      },
    },
  });
  const { data } = await response.json();
  const fulfillment = data?.fulfillmentCreate?.fulfillment;

  if (!fulfillment) {
    const message = data?.fulfillmentCreate?.userErrors?.[0]?.message;
    return { error: message ?? "Shopify couldn't mark these items shipped. Try again." };
  }

  // Shipping says more than accepting does, so a vendor who goes straight to it counts.
  if (!byStore && !vendorOrder.acceptedAt) {
    await db.vendorOrder.update({ where: { id: vendorOrder.id }, data: { acceptedAt: new Date() } });
  }

  const status = await saveShipment(vendorOrder, {
    fulfillmentId: fulfillment.id,
    tracking,
    items: shipping.map(({ line, quantity }) => ({ lineId: line.id, quantity })),
    shippedBy: byStore ? "store" : "vendor",
  });

  await db.vendorActivity.create({
    data: {
      vendorId: vendorOrder.vendorId,
      action: status === "FULFILLED" ? "order.fulfilled" : "order.partly_fulfilled",
      actor: byStore ? "merchant" : "vendor",
      details: { orderName: vendorOrder.orderName, tracking: tracking.number || null },
    },
  });

  return { ok: true, status };
}

// An order is overdue when it's still waiting to ship after the store's deadline.
export function overdueSince(days) {
  return new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000);
}

export const OVERDUE_WHERE = (days) => ({
  status: { in: ["OPEN", "PARTIAL"] },
  placedAt: { lt: overdueSince(days) },
});

export function vendorOrderFilter(shop, { status, vendorId, query, overdue, fulfillmentDays }) {
  const search = query?.trim();

  return {
    shop,
    ...(VENDOR_ORDER_STATUSES.includes(status) ? { status } : {}),
    ...(overdue ? OVERDUE_WHERE(fulfillmentDays) : {}),
    ...(vendorId ? { vendorId } : {}),
    ...(search
      ? {
          OR: [
            { orderName: { contains: search, mode: "insensitive" } },
            { customerName: { contains: search, mode: "insensitive" } },
            { customerEmail: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
}

export const ORDERS_PER_PAGE = 25;

export async function listVendorOrders(shop, filters, page = 1) {
  const where = vendorOrderFilter(shop, filters);
  const current = Math.max(1, Math.trunc(page) || 1);

  const [orders, matching, grouped, vendors, overdue] = await Promise.all([
    db.vendorOrder.findMany({
      where,
      orderBy: { placedAt: "desc" },
      skip: (current - 1) * ORDERS_PER_PAGE,
      take: ORDERS_PER_PAGE,
      include: {
        vendor: { select: { id: true, name: true } },
        // An open issue is a vendor waiting on the merchant, so it earns a badge in the list.
        _count: { select: { lines: true, issues: { where: { status: "OPEN" } } } },
      },
    }),
    db.vendorOrder.count({ where }),
    db.vendorOrder.groupBy({ by: ["status"], where: { shop }, _count: { _all: true } }),
    // Only vendors that actually have orders are worth filtering by.
    db.vendor.findMany({
      where: { shop, orders: { some: {} } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.vendorOrder.count({ where: { shop, ...OVERDUE_WHERE(filters.fulfillmentDays) } }),
  ]);

  return {
    orders,
    vendors,
    overdue,
    counts: Object.fromEntries(grouped.map((row) => [row.status, row._count._all])),
    page: {
      current,
      // The first row on this page, so the table can say which slice you're looking at.
      from: matching === 0 ? 0 : (current - 1) * ORDERS_PER_PAGE + 1,
      to: Math.min(current * ORDERS_PER_PAGE, matching),
      total: matching,
      hasPrevious: current > 1,
      hasNext: current * ORDERS_PER_PAGE < matching,
    },
  };
}

// Rows for the CSV export, capped so one click can't pull a whole year at once.
export function vendorOrdersForExport(shop, filters) {
  return db.vendorOrder.findMany({
    where: vendorOrderFilter(shop, filters),
    orderBy: { placedAt: "desc" },
    take: 1000,
    include: { vendor: { select: { name: true } } },
  });
}

export async function getVendorOrder(shop, id) {
  const vendorOrder = await db.vendorOrder.findFirst({
    where: { id, shop },
    include: {
      vendor: true,
      lines: { orderBy: { title: "asc" } },
      shipments: { orderBy: { createdAt: "desc" } },
      returns: { orderBy: { requestedAt: "desc" } },
      issues: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!vendorOrder) return null;

  // Lines moved to or away from this vendor, so the timeline can show the hand-over.
  const moves = await db.orderLineVendor.findMany({
    where: {
      shop,
      orderId: vendorOrder.orderId,
      OR: [{ vendorId: vendorOrder.vendorId }, { fromVendorId: vendorOrder.vendorId }],
    },
    orderBy: { createdAt: "desc" },
    include: { vendor: { select: { name: true } } },
  });
  const fromIds = [...new Set(moves.map((move) => move.fromVendorId).filter(Boolean))];
  const fromNames = fromIds.length
    ? await db.vendor.findMany({ where: { id: { in: fromIds } }, select: { id: true, name: true } })
    : [];
  const nameById = new Map(fromNames.map((vendor) => [vendor.id, vendor.name]));

  vendorOrder.lineMoves = moves.map((move) => ({
    title: move.title,
    createdAt: move.createdAt,
    mine: move.vendorId === vendorOrder.vendorId,
    toName: move.vendor.name,
    fromName: move.fromVendorId ? (nameById.get(move.fromVendorId) ?? "another vendor") : null,
  }));

  return vendorOrder;
}

// Everything that happened to this vendor order, newest first, built from the order itself
// and its shipments so there's no separate log to keep in step.
export function orderTimeline(vendorOrder, formatAmount) {
  const events = [];
  const add = (at, title, description = null, link = null) => {
    if (at) events.push({ at, title, description, link });
  };

  add(
    vendorOrder.placedAt,
    "Order placed",
    vendorOrder.customerName ? `${vendorOrder.customerName} checked out` : "Checked out in your store",
  );
  add(vendorOrder.paidAt, "Payment received", vendorOrder.financialStatus ?? null);
  add(
    vendorOrder.vendorSeenAt,
    `${vendorOrder.vendor.name} opened the order`,
    "They can see the items and the address from here on",
  );
  add(vendorOrder.acceptedAt, `${vendorOrder.vendor.name} took the order on`, "They said they're packing it");

  for (const shipment of vendorOrder.shipments) {
    const items = (shipment.items ?? []).map((item) => `${item.quantity} × ${item.title}`).join(", ");
    const tracking = [shipment.trackingCompany, shipment.trackingNumber].filter(Boolean).join(" · ");
    add(
      shipment.createdAt,
      shipment.shippedBy === "vendor" ? `${vendorOrder.vendor.name} shipped a parcel` : "You shipped a parcel",
      [items || null, tracking || "No tracking"].filter(Boolean).join(" · "),
      shipment.trackingUrl,
    );
  }

  for (const move of vendorOrder.lineMoves ?? []) {
    add(
      move.createdAt,
      move.mine ? `${move.title} moved here` : `${move.title} moved to another vendor`,
      move.mine ? `You moved it from ${move.fromName ?? "another vendor"}` : `You moved it to ${move.toName}`,
    );
  }

  for (const issue of vendorOrder.issues ?? []) {
    add(
      issue.createdAt,
      `${vendorOrder.vendor.name} can't ship this`,
      [reasonLabel(issue.reason), issue.note].filter(Boolean).join(" · "),
    );
    if (issue.status === "RESOLVED") {
      add(issue.resolvedAt, "You closed the vendor's request", issue.reviewNote);
    }
    if (issue.status === "WITHDRAWN") {
      add(issue.resolvedAt, `${vendorOrder.vendor.name} withdrew the request`, "They can ship it after all");
    }
  }

  for (const vendorReturn of vendorOrder.returns ?? []) {
    const items = (vendorReturn.items ?? []).map((item) => `${item.quantity} × ${item.title}`).join(", ");
    const reasons = [...new Set((vendorReturn.items ?? []).map((item) => item.reason).filter(Boolean))];
    const label = [returnLabel(vendorReturn.status), vendorReturn.name].filter(Boolean).join(" · ");

    add(vendorReturn.updatedAt, label, [items, reasons.join(", ")].filter(Boolean).join(" · "));
    if (vendorReturn.status !== "REQUESTED") {
      add(vendorReturn.requestedAt, `Return requested${vendorReturn.name ? ` · ${vendorReturn.name}` : ""}`, items);
    }
  }

  if (vendorOrder.status === "FULFILLED") {
    add(vendorOrder.fulfilledAt, "Everything shipped", "The customer has been emailed");
  }
  add(
    vendorOrder.refundedAt,
    "Refunded",
    `${formatAmount(vendorOrder.refunded)} back to the customer, ${formatAmount(vendorOrder.refundedCommission)} off your commission`,
  );
  add(vendorOrder.cancelledAt, "Order cancelled", "The vendor owes nothing on it");

  return events.sort((a, b) => b.at.getTime() - a.at.getTime());
}

// A vendor order with nothing left in it is a leftover from moving lines away.
async function dropEmptyVendorOrders(shop, orderId) {
  const empty = await db.vendorOrder.findMany({
    where: { shop, orderId, lines: { none: {} }, shipments: { none: {} } },
    select: { id: true },
  });
  if (empty.length) {
    await db.vendorOrder.deleteMany({ where: { id: { in: empty.map((order) => order.id) } } });
  }
}

// Moves one line to another vendor: the move is recorded, then the order is split again so
// commission, shipping and statuses are worked out by the same code as always.
export async function reassignOrderLine(admin, shop, { vendorOrderId, lineId, vendorId, actor }) {
  const line = await db.vendorOrderLine.findFirst({
    where: { id: lineId, vendorOrder: { id: vendorOrderId, shop } },
    include: {
      vendorOrder: {
        select: { id: true, orderId: true, orderName: true, vendorId: true, vendor: { select: { name: true } } },
      },
    },
  });
  if (!line) return { error: "That item isn't on this order" };

  const from = line.vendorOrder;
  if (from.vendorId === vendorId) return { error: `That item is already with ${from.vendor.name}` };
  // A shipped line has a fulfillment in the first vendor's name, so moving it would lie.
  if (line.shippedQuantity > 0) return { error: "That item has already been shipped" };
  if (line.refundedQuantity >= line.quantity) return { error: "That item was refunded" };

  const target = await db.vendor.findFirst({
    where: { id: vendorId, shop, status: "ACTIVE" },
    select: { id: true, name: true },
  });
  if (!target) return { error: "Choose an active vendor" };

  await db.orderLineVendor.upsert({
    where: { shop_orderId_lineItemId: { shop, orderId: from.orderId, lineItemId: line.lineItemId } },
    update: { vendorId: target.id, fromVendorId: from.vendorId, title: line.title, movedBy: actor },
    create: {
      shop,
      orderId: from.orderId,
      lineItemId: line.lineItemId,
      vendorId: target.id,
      fromVendorId: from.vendorId,
      title: line.title,
      movedBy: actor,
    },
  });

  await splitOrder(admin, shop, from.orderId);
  await dropEmptyVendorOrders(shop, from.orderId);

  const details = { orderName: from.orderName, title: line.title, from: from.vendor.name, to: target.name };
  await db.vendorActivity.createMany({
    data: [
      { vendorId: from.vendorId, action: "order.line_moved_out", actor, details },
      { vendorId: target.id, action: "order.line_moved_in", actor, details },
    ],
  });

  const stillThere = await db.vendorOrder.findUnique({ where: { id: from.id }, select: { id: true } });
  return { ok: true, movedTo: target.name, sourceGone: !stillThere };
}

// The vendor side of one Shopify order, for the block on the admin's order page.
export function vendorOrdersForShopifyOrder(shop, orderId) {
  return db.vendorOrder.findMany({
    where: { shop, orderId },
    orderBy: { createdAt: "asc" },
    include: {
      vendor: { select: { id: true, name: true } },
      lines: { select: { title: true, variantTitle: true, quantity: true, imageUrl: true } },
      shipments: {
        orderBy: { createdAt: "desc" },
        select: { trackingCompany: true, trackingNumber: true, trackingUrl: true, shippedBy: true },
      },
      returns: { where: { status: { in: ["REQUESTED", "OPEN"] } }, select: { id: true } },
      issues: { where: { status: "OPEN" }, select: { id: true } },
    },
  });
}

export async function vendorOrderTotals(shop) {
  const [open, earnings] = await Promise.all([
    db.vendorOrder.count({ where: { shop, status: { in: ["OPEN", "PARTIAL"] } } }),
    db.vendorOrder.aggregate({ where: { shop, status: { not: "CANCELLED" } }, _sum: { commission: true } }),
  ]);

  return { openVendorOrders: open, commissionEarned: earnings._sum.commission ?? 0 };
}
