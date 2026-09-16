import db from "../db.server";
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
    }
  }`;

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

    const group = groups.get(vendor.id) ?? { vendor, lines: [] };
    group.lines.push({
      lineItemId: line.id,
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
    const record = {
      status: "OPEN",
      orderName: order.name,
      currencyCode: order.currencyCode,
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
      placedAt,
    };

    await db.$transaction(async (tx) => {
      const existing = await tx.vendorOrder.findUnique({
        where: { shop_orderId_vendorId: { shop, orderId: order.id, vendorId: vendor.id } },
        select: { id: true, status: true },
      });

      if (existing) {
        await tx.vendorOrderLine.deleteMany({ where: { vendorOrderId: existing.id } });
        await tx.vendorOrder.update({
          where: { id: existing.id },
          // A vendor order already fulfilled or cancelled keeps its status.
          data: { ...record, status: existing.status, lines: { create: lines } },
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

export async function cancelVendorOrders(shop, orderGid) {
  await db.vendorOrder.updateMany({
    where: { shop, orderId: orderGid, status: { not: "CANCELLED" } },
    data: { status: "CANCELLED", cancelledAt: new Date() },
  });
}

// Marks a vendor order fulfilled once Shopify reports its lines shipped.
export async function syncFulfilledVendorOrders(shop, orderGid, fulfilledLineItemIds) {
  if (!fulfilledLineItemIds.length) return;

  const vendorOrders = await db.vendorOrder.findMany({
    where: { shop, orderId: orderGid, status: "OPEN" },
    include: { lines: { select: { lineItemId: true } } },
  });

  const now = new Date();
  for (const vendorOrder of vendorOrders) {
    const allShipped = vendorOrder.lines.every((line) => fulfilledLineItemIds.includes(line.lineItemId));
    if (!allShipped) continue;

    await db.vendorOrder.update({
      where: { id: vendorOrder.id },
      data: { status: "FULFILLED", fulfilledAt: now },
    });
  }
}

export async function listVendorOrders(shop, { status, vendorId }) {
  const where = {
    shop,
    ...(VENDOR_ORDER_STATUSES.includes(status) ? { status } : {}),
    ...(vendorId ? { vendorId } : {}),
  };

  const [orders, grouped] = await Promise.all([
    db.vendorOrder.findMany({
      where,
      orderBy: { placedAt: "desc" },
      take: 100,
      include: {
        vendor: { select: { id: true, name: true } },
        _count: { select: { lines: true } },
      },
    }),
    db.vendorOrder.groupBy({ by: ["status"], where: { shop }, _count: { _all: true } }),
  ]);

  return {
    orders,
    counts: Object.fromEntries(grouped.map((row) => [row.status, row._count._all])),
  };
}

export function getVendorOrder(shop, id) {
  return db.vendorOrder.findFirst({
    where: { id, shop },
    include: { vendor: true, lines: { orderBy: { title: "asc" } } },
  });
}

export async function vendorOrderTotals(shop) {
  const [open, earnings] = await Promise.all([
    db.vendorOrder.count({ where: { shop, status: "OPEN" } }),
    db.vendorOrder.aggregate({ where: { shop, status: { not: "CANCELLED" } }, _sum: { commission: true } }),
  ]);

  return { openVendorOrders: open, commissionEarned: earnings._sum.commission ?? 0 };
}
