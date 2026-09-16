import db from "../db.server";
import { unauthenticated } from "../shopify.server";
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
      taxesIncluded
      email
      phone
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
          originalUnitPriceSet {
            shopMoney {
              amount
            }
          }
          discountedTotalSet {
            shopMoney {
              amount
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
  const vendorByProduct = await vendorIdsByProduct(shop, lineItems);
  if (!vendorByProduct.size) return { vendorOrders: 0 };

  const [settings, vendors] = await Promise.all([
    getShopSettings(shop),
    db.vendor.findMany({
      where: { shop, id: { in: [...new Set(vendorByProduct.values())] } },
    }),
  ]);
  const vendorById = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const fulfillment = fulfillmentByLineItem(order);
  const refunds = refundsByLineItem(order);

  // Group the order's lines by vendor and work out what each line earns.
  const groups = new Map();
  for (const line of lineItems) {
    const vendorId = vendorByProduct.get(line.product?.id);
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

    const refund = refunds.get(line.id);
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

  for (const { vendor, lines } of groups.values()) {
    const subtotal = round2(lines.reduce((sum, line) => sum + Number(line.subtotal), 0));
    const commission = round2(lines.reduce((sum, line) => sum + Number(line.commission), 0));
    const shipping = shippingForVendor(vendor);
    const refunded = round2(lines.reduce((sum, line) => sum + Number(line.refundedSubtotal ?? 0), 0));
    const refundedCommission = round2(
      lines.reduce((sum, line) => {
        const refundedSubtotal = Number(line.refundedSubtotal ?? 0);
        if (!refundedSubtotal) return sum;
        const share = Number(line.subtotal) > 0 ? refundedSubtotal / Number(line.subtotal) : 1;
        return sum + Number(line.commission) * share;
      }, 0),
    );
    const record = {
      status: "OPEN",
      orderName: order.name,
      currencyCode: order.currencyCode,
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
      refundedEarnings: round2(refunded - refundedCommission).toFixed(2),
      placedAt,
      paidAt: PAID_STATUSES.includes(order.displayFinancialStatus) ? new Date() : null,
    };

    await db.$transaction(async (tx) => {
      const existing = await tx.vendorOrder.findUnique({
        where: { shop_orderId_vendorId: { shop, orderId: order.id, vendorId: vendor.id } },
        select: {
          id: true,
          status: true,
          paidAt: true,
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
          // A vendor order already fulfilled or cancelled keeps its status.
          data: {
            ...record,
            status: existing.status,
            paidAt: existing.paidAt ?? record.paidAt,
            lines: { create: keptLines },
          },
        });
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

  return { vendorOrders: groups.size };
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

// Orders placed before the app was installed never arrive by webhook. This pulls in recent
// ones a batch at a time, newest first, skipping orders that are already split.
export async function syncRecentOrders(admin, shop, { days = 60, batchSize = 20 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const query = `created_at:>=${since}`;

  const candidates = [];
  let cursor = null;
  // Look through up to 500 recent orders to find ones still missing.
  for (let page = 0; page < 5; page++) {
    const response = await admin.graphql(RECENT_ORDERS, { variables: { query, cursor } });
    const { data } = await response.json();
    const orders = data?.orders;
    if (!orders) break;

    const ids = orders.nodes.map((order) => order.id);
    const known = await db.vendorOrder.findMany({
      where: { shop, orderId: { in: ids } },
      select: { orderId: true },
      distinct: ["orderId"],
    });
    const knownIds = new Set(known.map((row) => row.orderId));
    candidates.push(...ids.filter((id) => !knownIds.has(id)));

    cursor = orders.pageInfo.hasNextPage ? orders.pageInfo.endCursor : null;
    if (!cursor || candidates.length >= batchSize) break;
  }

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

// A refund reverses part of a sale: the vendor's share of the refunded lines, and the
// commission taken on them, so payouts only pay for goods the customer kept.
export async function applyRefund(shop, orderGid, refundLines) {
  if (!refundLines.length) return;

  const vendorOrders = await db.vendorOrder.findMany({
    where: { shop, orderId: orderGid },
    include: { lines: true },
  });
  if (!vendorOrders.length) return;

  for (const vendorOrder of vendorOrders) {
    const updates = [];

    for (const line of vendorOrder.lines) {
      const refunds = refundLines.filter((refund) => refund.lineItemId === line.lineItemId);
      if (!refunds.length) continue;

      const quantity = refunds.reduce((sum, refund) => sum + refund.quantity, 0);
      const amount = refunds.reduce((sum, refund) => sum + refund.subtotal, 0);
      updates.push({
        id: line.id,
        refundedQuantity: Math.min(line.quantity, line.refundedQuantity + quantity),
        refundedSubtotal: Math.min(Number(line.subtotal), round2(Number(line.refundedSubtotal) + amount)),
      });
    }

    if (!updates.length) continue;

    const byId = new Map(updates.map((update) => [update.id, update]));
    let refunded = 0;
    let refundedCommission = 0;

    for (const line of vendorOrder.lines) {
      const update = byId.get(line.id);
      const refundedSubtotal = update ? update.refundedSubtotal : Number(line.refundedSubtotal);
      if (!refundedSubtotal) continue;

      // Commission comes back in the same proportion as the money refunded.
      const share = Number(line.subtotal) > 0 ? refundedSubtotal / Number(line.subtotal) : 1;
      refunded = round2(refunded + refundedSubtotal);
      refundedCommission = round2(refundedCommission + Number(line.commission) * share);
    }

    await db.$transaction([
      ...updates.map((update) =>
        db.vendorOrderLine.update({
          where: { id: update.id },
          data: {
            refundedQuantity: update.refundedQuantity,
            refundedSubtotal: update.refundedSubtotal.toFixed(2),
          },
        }),
      ),
      db.vendorOrder.update({
        where: { id: vendorOrder.id },
        data: {
          refunded: refunded.toFixed(2),
          refundedCommission: refundedCommission.toFixed(2),
          refundedEarnings: round2(refunded - refundedCommission).toFixed(2),
        },
      }),
      db.vendorActivity.create({
        data: {
          vendorId: vendorOrder.vendorId,
          action: "order.refunded",
          actor: "shopify",
          details: { orderName: vendorOrder.orderName, refunded: refunded.toFixed(2) },
        },
      }),
    ]);
  }
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

// Open, partly shipped, or fully shipped, based on what's left to send.
// Refunded items don't need shipping.
function statusFromLines(lines) {
  const outstanding = lines.reduce(
    (sum, line) => sum + Math.max(0, line.quantity - line.refundedQuantity - line.shippedQuantity),
    0,
  );
  const shipped = lines.reduce((sum, line) => sum + line.shippedQuantity, 0);

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
  const status = statusFromLines(updatedLines);

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

// Shipments made in Shopify admin, or by anyone else, keep vendor orders in step.
// A shipment the portal just created arrives here too, and is ignored by its fulfillment id.
export async function recordStoreFulfillment(shop, orderGid, { fulfillmentId, tracking, lines }) {
  if (!lines.length) return;

  if (fulfillmentId) {
    const known = await db.vendorShipment.findFirst({ where: { fulfillmentId }, select: { id: true } });
    if (known) return;
  }

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
    await saveShipment(vendorOrder, { fulfillmentId, tracking, items, shippedBy: "store" });
  }
}

// Ships a vendor's lines in Shopify. Called by the vendor portal through /api/portal/fulfill,
// because the portal has no Shopify access of its own.
export async function fulfillVendorOrder(vendorOrderId, vendorId, tracking, requestedItems = []) {
  const vendorOrder = await db.vendorOrder.findFirst({
    where: { id: vendorOrderId, vendorId },
    include: { lines: true },
  });
  if (!vendorOrder) return { error: "Order not found" };
  if (vendorOrder.status === "CANCELLED") return { error: "This order was cancelled" };
  if (vendorOrder.status === "FULFILLED") return { error: "This order is already marked shipped" };
  if (vendorOrder.shippingMode === "STORE_SHIPS") {
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

  const status = await saveShipment(vendorOrder, {
    fulfillmentId: fulfillment.id,
    tracking,
    items: shipping.map(({ line, quantity }) => ({ lineId: line.id, quantity })),
    shippedBy: "vendor",
  });

  await db.vendorActivity.create({
    data: {
      vendorId: vendorOrder.vendorId,
      action: status === "FULFILLED" ? "order.fulfilled" : "order.partly_fulfilled",
      actor: "vendor",
      details: { orderName: vendorOrder.orderName, tracking: tracking.number || null },
    },
  });

  return { ok: true, status };
}

export function vendorOrderFilter(shop, { status, vendorId, query }) {
  const search = query?.trim();

  return {
    shop,
    ...(VENDOR_ORDER_STATUSES.includes(status) ? { status } : {}),
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

export async function listVendorOrders(shop, filters) {
  const [orders, grouped, vendors] = await Promise.all([
    db.vendorOrder.findMany({
      where: vendorOrderFilter(shop, filters),
      orderBy: { placedAt: "desc" },
      take: 100,
      include: {
        vendor: { select: { id: true, name: true } },
        _count: { select: { lines: true } },
      },
    }),
    db.vendorOrder.groupBy({ by: ["status"], where: { shop }, _count: { _all: true } }),
    // Only vendors that actually have orders are worth filtering by.
    db.vendor.findMany({
      where: { shop, orders: { some: {} } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  return {
    orders,
    vendors,
    counts: Object.fromEntries(grouped.map((row) => [row.status, row._count._all])),
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

export function getVendorOrder(shop, id) {
  return db.vendorOrder.findFirst({
    where: { id, shop },
    include: {
      vendor: true,
      lines: { orderBy: { title: "asc" } },
      shipments: { orderBy: { createdAt: "desc" } },
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
