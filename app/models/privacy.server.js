import { Prisma } from "@prisma/client";
import db from "../db.server";
import { sendEmail } from "./email.server";

// Shopify's three privacy webhooks, done properly.
//
// The template's versions were stubs that said "no customer data is stored yet". That
// stopped being true the day vendor orders arrived: an order carries the buyer's name,
// email, phone and where the parcel goes. So:
//
//   customers/data_request — gather what we hold and hand it to the merchant, who is the
//                            one with the legal duty to answer the customer.
//   customers/redact       — take the buyer out of the orders without destroying the
//                            accounting. The money has to stay; the person doesn't.
//   shop/redact            — erase the shop, all of it, 48 hours after uninstall.
//
// Every one is written down with what it did, because "we deleted it" is worth nothing
// without a date next to it.

// The payload gives numeric ids; we store Shopify GIDs.
const orderGids = (ids) => (ids ?? []).map((id) => `gid://shopify/Order/${id}`);

function customerMatch(shop, customer, orderIds) {
  const or = [];
  if (customer?.email) or.push({ customerEmail: { equals: customer.email, mode: "insensitive" } });
  const gids = orderGids(orderIds);
  if (gids.length) or.push({ orderId: { in: gids } });

  // Without an email or an order there is nothing to match on, and a query with an empty
  // OR would match the whole shop, so it is made to match nothing instead.
  return { shop, ...(or.length ? { OR: or } : { id: "no-such-order" }) };
}

/**
 * customers/data_request: the buyer has asked their store what it holds on them, and we
 * hold part of it. Compiled and handed to the merchant, who answers the customer.
 */
export async function recordDataRequest(shop, payload) {
  const customer = payload?.customer ?? {};
  const orders = await db.vendorOrder.findMany({
    where: customerMatch(shop, customer, payload?.orders_requested),
    include: {
      vendor: { select: { name: true } },
      lines: { select: { title: true, variantTitle: true, quantity: true, unitPrice: true } },
      shipments: { select: { trackingCompany: true, trackingNumber: true, createdAt: true } },
    },
  });

  const data = {
    collectedAt: new Date().toISOString(),
    // Said plainly, because this ends up in front of a customer who asked a simple question.
    about:
      "The marketplace app for this store keeps a copy of each order, split by seller, so " +
      "each seller can pack and post their own part of it. This is everything it holds " +
      "about this customer.",
    customer: { id: customer.id ?? null, email: customer.email ?? null, phone: customer.phone ?? null },
    orders: orders.map((order) => ({
      order: order.orderName,
      soldBy: order.vendor.name,
      placedAt: order.placedAt.toISOString(),
      name: order.customerName,
      email: order.customerEmail,
      phone: order.customerPhone,
      deliveryAddress: order.shippingAddress,
      items: order.lines.map((line) => ({
        item: [line.title, line.variantTitle].filter(Boolean).join(" · "),
        quantity: line.quantity,
        price: line.unitPrice.toString(),
      })),
      deliveries: order.shipments.map((shipment) => ({
        courier: shipment.trackingCompany,
        tracking: shipment.trackingNumber,
        sentAt: shipment.createdAt.toISOString(),
      })),
    })),
  };

  const summary =
    orders.length === 0
      ? "Nothing held for this customer"
      : `${orders.length} ${orders.length === 1 ? "order" : "orders"} ready to hand over`;

  const request = await db.privacyRequest.create({
    data: {
      shop,
      type: "CUSTOMER_DATA",
      customerId: customer.id ? String(customer.id) : null,
      customerEmail: customer.email ?? null,
      requestId: payload?.data_request?.id ? String(payload.data_request.id) : null,
      data,
      summary,
      completedAt: new Date(),
    },
  });

  await tellTheMerchant(shop, {
    subject: "A customer has asked what data you hold on them",
    text: [
      `${customer.email ?? "A customer"} has made a data request through Shopify.`,
      "",
      `The marketplace app holds ${summary.toLowerCase()}.`,
      "",
      "Open the app, go to Privacy requests, and download it to send on. You have 30 days " +
        "to answer, and the copy is deleted here after that.",
    ].join("\n"),
    template: "privacy.data_request",
    related: { type: "privacy", id: request.id },
  });

  return request;
}

/**
 * customers/redact: the buyer is to be taken out of the store's records. Their details
 * come off the orders; the orders themselves, and every figure that hangs off them, stay.
 * A marketplace that forgot its sales because a customer left would have no accounts.
 */
export async function redactCustomer(shop, payload) {
  const customer = payload?.customer ?? {};
  const where = customerMatch(shop, customer, payload?.orders_to_redact);

  const orders = await db.vendorOrder.findMany({ where, select: { id: true, orderName: true } });

  if (orders.length) {
    await db.vendorOrder.updateMany({
      where: { id: { in: orders.map((order) => order.id) } },
      data: {
        customerName: null,
        customerEmail: null,
        customerPhone: null,
        shippingAddress: null,
      },
    });
  }

  // Anything we gathered for an earlier data request about this same person goes too,
  // otherwise the details would survive in the very record that proves they were removed.
  const cleared = await db.privacyRequest.updateMany({
    where: {
      shop,
      type: "CUSTOMER_DATA",
      ...(customer.email
        ? { customerEmail: { equals: customer.email, mode: "insensitive" } }
        : { customerId: customer.id ? String(customer.id) : "no-such-customer" }),
    },
    data: { data: Prisma.DbNull, summary: "Cleared: the customer asked to be forgotten" },
  });

  const summary = orders.length
    ? `Details removed from ${orders.length} ${orders.length === 1 ? "order" : "orders"}` +
      `${cleared.count ? `, and ${cleared.count} earlier data ${cleared.count === 1 ? "request" : "requests"} cleared` : ""}`
    : "Nothing held for this customer";

  return db.privacyRequest.create({
    data: {
      shop,
      type: "CUSTOMER_REDACT",
      customerId: customer.id ? String(customer.id) : null,
      // Kept only so the merchant can see which request was dealt with; it is the id
      // Shopify sent, not something we went looking for.
      customerEmail: null,
      summary,
      completedAt: new Date(),
    },
  });
}

/**
 * shop/redact: 48 hours after the app is uninstalled, everything belonging to that shop
 * goes. Deleting a vendor takes their users, sessions, products, shipping zones, change
 * requests and activity with it; the rest is listed here because it is keyed by shop.
 */
export async function redactShop(shop) {
  const counts = await db.$transaction([
    db.vendorOrder.deleteMany({ where: { shop } }),
    db.orderLineVendor.deleteMany({ where: { shop } }),
    db.ledgerEntry.deleteMany({ where: { shop } }),
    db.payout.deleteMany({ where: { shop } }),
    db.commissionInvoice.deleteMany({ where: { shop } }),
    db.productSubmission.deleteMany({ where: { shop } }),
    db.vendorProduct.deleteMany({ where: { shop } }),
    db.vendorShippingZone.deleteMany({ where: { shop } }),
    db.vendorChangeRequest.deleteMany({ where: { shop } }),
    db.vendorAgreementAcceptance.deleteMany({ where: { shop } }),
    db.vendorAgreement.deleteMany({ where: { shop } }),
    db.vendor.deleteMany({ where: { shop } }),
    db.shopCollection.deleteMany({ where: { shop } }),
    db.shopCarrier.deleteMany({ where: { shop } }),
    db.emailMessage.deleteMany({ where: { shop } }),
    db.webhookEvent.deleteMany({ where: { shop } }),
    db.errorEvent.deleteMany({ where: { shop } }),
    db.shopSettings.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
    // Last, and after its own kind: the record of earlier requests is data about this shop
    // too, so it goes with the rest.
    db.privacyRequest.deleteMany({ where: { shop } }),
  ]);

  return counts.reduce((total, result) => total + result.count, 0);
}

async function tellTheMerchant(shop, message) {
  const settings = await db.shopSettings.findUnique({ where: { shop }, select: { shopEmail: true } });
  if (!settings?.shopEmail) return;

  await sendEmail(shop, { to: settings.shopEmail, ...message });
}

export function listPrivacyRequests(shop, { limit = 50 } = {}) {
  return db.privacyRequest.findMany({
    where: { shop },
    orderBy: { receivedAt: "desc" },
    take: limit,
  });
}

export function privacyRequest(shop, id) {
  return db.privacyRequest.findFirst({ where: { id, shop } });
}

export function acknowledgePrivacyRequest(shop, id) {
  return db.privacyRequest.updateMany({ where: { id, shop }, data: { acknowledgedAt: new Date() } });
}

// Shopify gives a merchant 30 days to answer a data request. After that the copy gathered
// here is nobody's business, so it goes; the record that the request happened stays.
const KEEP_DATA_DAYS = 30;

export function prunePrivacyData() {
  return db.privacyRequest.updateMany({
    where: {
      type: "CUSTOMER_DATA",
      data: { not: Prisma.DbNull },
      receivedAt: { lt: new Date(Date.now() - KEEP_DATA_DAYS * 24 * 60 * 60 * 1000) },
    },
    data: { data: Prisma.DbNull, summary: "The 30 days are up, so the copy has been deleted" },
  });
}

// Data requests the merchant hasn't handed over yet. On the app's home page, because it is
// the one thing there with a legal clock on it.
export function countWaitingDataRequests(shop) {
  return db.privacyRequest.count({
    where: { shop, type: "CUSTOMER_DATA", acknowledgedAt: null, data: { not: Prisma.DbNull } },
  });
}
