import db from "../db.server";
import { formatMoney } from "../utils/money";
import { sendEmail } from "./email.server";

// Every email the marketplace sends, in one place.
//
// Two audiences. A vendor is told what happened to their money, their products and their
// orders; a merchant is told the things only they can act on. Plain, short, and each one
// says what happens next, because these are read by someone in the middle of something
// else. Nothing here throws: a notification that can't go out must not take down the thing
// that triggered it, and every message is in the email log either way.

async function payoutContext(shop, payoutId) {
  const [payout, settings] = await Promise.all([
    db.payout.findFirst({
      where: { id: payoutId, shop },
      include: { vendor: { select: { name: true, email: true } } },
    }),
    db.shopSettings.findUnique({ where: { shop } }),
  ]);
  if (!payout) return null;

  return {
    payout,
    vendor: payout.vendor,
    amount: formatMoney(payout.amount, payout.currencyCode),
    // The legal name once the store sets it up for invoices; the shop's handle until then.
    store: settings?.businessName || shop.replace(/\.myshopify\.com$/, ""),
    portal: process.env.VENDOR_PORTAL_URL ? `${process.env.VENDOR_PORTAL_URL.replace(/\/$/, "")}/earnings` : null,
  };
}

function footer(context) {
  return context.portal
    ? `See every payout and your statement: ${context.portal}\n\n${context.store}`
    : context.store;
}

async function notify(shop, payoutId, template, build) {
  const context = await payoutContext(shop, payoutId);
  if (!context) return;

  const { subject, body } = build(context);
  await sendEmail(shop, {
    to: context.vendor.email,
    subject,
    text: `Hi ${context.vendor.name},\n\n${body}\n\n${footer(context)}`,
    template,
    related: { type: "payout", id: payoutId },
  });
}

export function notifyPayoutSent(shop, payoutId) {
  return notify(shop, payoutId, "payout.paid", (context) => ({
    subject: `${context.amount} is on its way to you`,
    body: [
      `${context.store} has sent you ${context.amount}.`,
      context.payout.reference ? `Reference: ${context.payout.reference}` : null,
      "Depending on your bank or wallet it can take a few days to show up.",
    ]
      .filter(Boolean)
      .join("\n"),
  }));
}

export function notifyPayoutBounced(shop, payoutId) {
  return notify(shop, payoutId, "payout.failed", (context) => ({
    subject: `Your payout of ${context.amount} didn't go through`,
    body: `The transfer of ${context.amount} bounced back, so the money is on your balance again.\nCheck your payout details are right; the store will send it again.`,
  }));
}

export function notifyPayoutCalledOff(shop, payoutId) {
  return notify(shop, payoutId, "payout.cancelled", (context) => ({
    subject: `A payout of ${context.amount} was called off`,
    body: [
      `${context.store} called off a payout of ${context.amount} before it was sent. The money is back on your balance.`,
      context.payout.note ? `Their note: ${context.payout.note}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  }));
}

export function notifyPayoutRequestAccepted(shop, payoutId) {
  return notify(shop, payoutId, "payout.accepted", (context) => ({
    subject: `Your payout request for ${context.amount} was accepted`,
    body: `${context.store} accepted your request and will send ${context.amount} shortly. You'll get another email when it's on its way.`,
  }));
}

export function notifyPayoutRequestDeclined(shop, payoutId) {
  return notify(shop, payoutId, "payout.declined", (context) => ({
    subject: "Your payout request wasn't accepted this time",
    body: [
      `${context.store} didn't accept your request for ${context.amount}. The money stays on your balance.`,
      context.payout.note ? `Their note: ${context.payout.note}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  }));
}

// --- Everything else -------------------------------------------------------------------

const portalLink = (path = "") => {
  // eslint-disable-next-line no-undef
  const base = process.env.VENDOR_PORTAL_URL?.replace(/\/$/, "");
  return base ? `${base}${path}` : null;
};

async function storeName(shop) {
  const settings = await db.shopSettings.findUnique({
    where: { shop },
    select: { businessName: true, shopName: true, shopEmail: true },
  });
  return {
    // The legal name once the store sets it up for invoices; the shop's handle until then.
    store: settings?.businessName || settings?.shopName || shop.replace(/\.myshopify\.com$/, ""),
    shopEmail: settings?.shopEmail ?? null,
  };
}

/**
 * A message to one vendor's contact address, signed off by the store with a way back into
 * the portal. `lines` are paragraphs; nulls are dropped, so a line can be conditional.
 */
async function emailVendor(shop, vendorId, { subject, lines, template, related, link = "/dashboard" }) {
  const vendor = await db.vendor.findFirst({
    where: { id: vendorId, shop },
    select: { name: true, email: true },
  });
  if (!vendor?.email) return { skipped: "No vendor address" };

  const { store } = await storeName(shop);
  const url = link === "" ? null : portalLink(link);

  return sendEmail(shop, {
    to: vendor.email,
    subject,
    text: [`Hi ${vendor.name},`, ...lines.filter(Boolean), url, store].filter(Boolean).join("\n\n"),
    template,
    related,
  });
}

/**
 * A message to the merchant, for the things only they can act on. Sent to the store's
 * contact address, which is the one they already use for their sellers.
 */
async function emailMerchant(shop, { subject, lines, template, related }) {
  const { store, shopEmail } = await storeName(shop);
  if (!shopEmail) return { skipped: "The store has no contact address" };

  return sendEmail(shop, {
    to: shopEmail,
    subject,
    text: [...lines.filter(Boolean), `${store} marketplace`].join("\n\n"),
    template,
    related,
  });
}

// --- A vendor joining, pausing, coming back ---------------------------------------------

export async function notifyVendorApproved(shop, vendorId, inviteUrl) {
  const { store } = await storeName(shop);

  return emailVendor(shop, vendorId, {
    subject: `You can start selling with ${store}`,
    lines: [
      `${store} has approved you as a seller.`,
      inviteUrl
        ? `Choose a password and you are in:\n${inviteUrl}`
        : "Sign in to the seller portal to add your products. If you have not set a password yet, ask the store for your invite link.",
      "Anything you add is looked at by the store before it goes on sale, unless they tell you otherwise.",
    ],
    template: "vendor.approved",
    related: { type: "vendor", id: vendorId },
    link: inviteUrl ? "" : "/products",
  });
}

export async function notifyVendorRejected(shop, vendorId, reason) {
  const { store } = await storeName(shop);

  return emailVendor(shop, vendorId, {
    subject: `${store} is not taking your application further`,
    lines: [
      `${store} has looked at your application and is not taking it further this time.`,
      reason ? `What they said: ${reason}` : null,
      "If you think that is a mistake, reply to this email and it will reach them.",
    ],
    template: "vendor.rejected",
    related: { type: "vendor", id: vendorId },
    link: "",
  });
}

export async function notifyVendorPaused(shop, vendorId, reason) {
  const { store } = await storeName(shop);

  return emailVendor(shop, vendorId, {
    subject: "Your selling has been paused",
    lines: [
      `${store} has paused your account, so your products are not on sale for now.`,
      reason ? `What they said: ${reason}` : null,
      "Orders you already have still need posting, and money you have earned is still yours.",
    ],
    template: "vendor.paused",
    related: { type: "vendor", id: vendorId },
    link: "/orders",
  });
}

export async function notifyVendorReactivated(shop, vendorId) {
  const { store } = await storeName(shop);

  return emailVendor(shop, vendorId, {
    subject: "You are selling again",
    lines: [`${store} has put your account back on, and your products are on sale again.`],
    template: "vendor.reactivated",
    related: { type: "vendor", id: vendorId },
  });
}

export async function notifyVendorInvited(shop, vendorId, inviteUrl) {
  const { store } = await storeName(shop);

  return emailVendor(shop, vendorId, {
    subject: `Set up your seller account with ${store}`,
    lines: [
      `${store} has set you up as a seller on their marketplace.`,
      `Choose a password and you are in:\n${inviteUrl}`,
      "The link works once, and runs out in a week. If it has expired, ask the store for a new one.",
    ],
    template: "vendor.invited",
    related: { type: "vendor", id: vendorId },
    link: "",
  });
}

// --- Orders -----------------------------------------------------------------------------

export async function notifyNewOrder(shop, vendorOrderId) {
  const order = await db.vendorOrder.findUnique({
    where: { id: vendorOrderId },
    select: {
      id: true,
      shop: true,
      vendorId: true,
      orderName: true,
      cashOnDelivery: true,
      lines: { select: { quantity: true, title: true } },
    },
  });
  if (!order || order.shop !== shop) return { skipped: "Order not found" };

  const items = order.lines.reduce((total, line) => total + line.quantity, 0);
  const settings = await db.shopSettings.findUnique({
    where: { shop },
    select: { fulfillmentDays: true },
  });

  return emailVendor(shop, order.vendorId, {
    subject: `New order ${order.orderName}: ${items} ${items === 1 ? "item" : "items"} to post`,
    lines: [
      `You have sold ${items === 1 ? "an item" : `${items} items`} on order ${order.orderName}.`,
      order.lines.map((line) => `${line.quantity} x ${line.title}`).join("\n"),
      order.cashOnDelivery
        ? "This one is cash on delivery: you take the money at the door, then say so in the portal."
        : null,
      `The store expects it posted within ${settings?.fulfillmentDays ?? 3} days. The address and the packing slip are in the portal.`,
    ],
    template: "order.new",
    related: { type: "vendorOrder", id: order.id },
    link: `/orders/${order.id}`,
  });
}

export async function notifyOrderCancelled(shop, vendorOrderId) {
  const order = await db.vendorOrder.findUnique({
    where: { id: vendorOrderId },
    select: { id: true, shop: true, vendorId: true, orderName: true },
  });
  if (!order || order.shop !== shop) return { skipped: "Order not found" };

  return emailVendor(shop, order.vendorId, {
    subject: `Order ${order.orderName} was cancelled`,
    lines: [
      `Order ${order.orderName} has been cancelled, so there is nothing to post.`,
      "Anything you had earned on it has come off your balance.",
    ],
    template: "order.cancelled",
    related: { type: "vendorOrder", id: order.id },
    link: `/orders/${order.id}`,
  });
}

export async function notifyReturnRequested(shop, vendorOrderId, returnName) {
  const order = await db.vendorOrder.findUnique({
    where: { id: vendorOrderId },
    select: { id: true, shop: true, vendorId: true, orderName: true },
  });
  if (!order || order.shop !== shop) return { skipped: "Order not found" };

  return emailVendor(shop, order.vendorId, {
    subject: `A customer wants to return something from ${order.orderName}`,
    lines: [
      `There is a return request on order ${order.orderName}${returnName ? ` (${returnName})` : ""}.`,
      "What is coming back, and what to do about it, is in the portal.",
    ],
    template: "return.requested",
    related: { type: "vendorOrder", id: order.id },
    link: `/orders/${order.id}`,
  });
}

// --- Products ---------------------------------------------------------------------------

export function notifyProductApproved(shop, vendorId, { title, submissionId, edit = false }) {
  return emailVendor(shop, vendorId, {
    subject: edit ? `Your changes to "${title}" are live` : `"${title}" is on sale`,
    lines: [
      edit
        ? `The store has approved your changes to "${title}" and they are live in the shop.`
        : `The store has approved "${title}" and it is on sale now.`,
    ],
    template: edit ? "product.edit_approved" : "product.approved",
    related: { type: "productSubmission", id: submissionId },
    link: "/products",
  });
}

export function notifyProductRejected(shop, vendorId, { title, submissionId, note, edit = false }) {
  return emailVendor(shop, vendorId, {
    subject: edit ? `Your changes to "${title}" need another look` : `"${title}" needs another look`,
    lines: [
      edit
        ? `The store has not approved your changes to "${title}". What is on sale has not changed.`
        : `The store has not approved "${title}" yet.`,
      note ? `What they said: ${note}` : null,
      "Your draft is still in the portal: put it right and send it again.",
    ],
    template: edit ? "product.edit_rejected" : "product.rejected",
    related: { type: "productSubmission", id: submissionId },
    link: "/products",
  });
}

// --- Payout details and agreements --------------------------------------------------------

export function notifyChangeApproved(shop, vendorId, changeId) {
  return emailVendor(shop, vendorId, {
    subject: "Your new payout details are in use",
    lines: [
      "The store has approved the payout details you asked to change. Anything sent from now on goes to the new account.",
    ],
    template: "change.approved",
    related: { type: "changeRequest", id: changeId },
    link: "/settings",
  });
}

export function notifyChangeRejected(shop, vendorId, changeId, note) {
  return emailVendor(shop, vendorId, {
    subject: "Your payout details were not changed",
    lines: [
      "The store has not approved the change to your payout details, so the old ones are still in use.",
      note ? `What they said: ${note}` : null,
    ],
    template: "change.rejected",
    related: { type: "changeRequest", id: changeId },
    link: "/settings",
  });
}

export async function notifyAgreementPublished(shop, agreementId) {
  const vendors = await db.vendor.findMany({ where: { shop, status: "ACTIVE" }, select: { id: true } });
  const { store } = await storeName(shop);

  // One at a time on purpose: a provider will throttle a burst, and a slow send beats a
  // batch that half arrives.
  for (const vendor of vendors) {
    await emailVendor(shop, vendor.id, {
      subject: `${store} has a new seller agreement`,
      lines: [
        `${store} has published a new seller agreement.`,
        "Read it and sign it in the portal. Until you do, you will not be able to add products or send out orders.",
      ],
      template: "agreement.published",
      related: { type: "agreement", id: agreementId },
      link: "/agreement",
    });
  }

  return { sent: vendors.length };
}

// --- What the merchant is told --------------------------------------------------------------

export function notifyMerchantApplication(shop, vendorId, name) {
  return emailMerchant(shop, {
    subject: `${name} has applied to sell in your store`,
    lines: [
      `${name} has applied to sell with you.`,
      "Open the app, read what they said, and approve or turn them down.",
    ],
    template: "merchant.application",
    related: { type: "vendor", id: vendorId },
  });
}

export function notifyMerchantProductSubmitted(shop, submissionId, { vendorName, title, edit = false }) {
  return emailMerchant(shop, {
    subject: edit ? `${vendorName} wants to change "${title}"` : `${vendorName} has a product waiting for you`,
    lines: [
      edit
        ? `${vendorName} wants to change "${title}", which is already on sale.`
        : `${vendorName} has sent "${title}" for approval.`,
      "Nothing changes in your shop until you say so. Product approvals are in the app.",
    ],
    template: edit ? "merchant.product_edit" : "merchant.product",
    related: { type: "productSubmission", id: submissionId },
  });
}

export function notifyMerchantPayoutRequested(shop, payoutId, { vendorName, amount }) {
  return emailMerchant(shop, {
    subject: `${vendorName} has asked for ${amount}`,
    lines: [
      `${vendorName} has asked to be paid ${amount}.`,
      "Accept it and it joins the payouts waiting to go out; turn it down and the money stays on their balance.",
    ],
    template: "merchant.payout_request",
    related: { type: "payout", id: payoutId },
  });
}

export function notifyMerchantChangeRequested(shop, changeId, vendorName) {
  return emailMerchant(shop, {
    subject: `${vendorName} wants to change their payout details`,
    lines: [
      `${vendorName} has asked to change where their money goes.`,
      "Nothing is paid to the new account until you approve it. Setting changes are in the app.",
    ],
    template: "merchant.change_request",
    related: { type: "changeRequest", id: changeId },
  });
}

export function notifyMerchantOrderIssue(shop, vendorOrderId, { vendorName, orderName, reason, note }) {
  return emailMerchant(shop, {
    subject: `${vendorName} has a problem with order ${orderName}`,
    lines: [
      `${vendorName} has flagged ${orderName}: ${reason}.`,
      note ? `What they said: ${note}` : null,
      "A customer is waiting on this one. Orders are in the app.",
    ],
    template: "merchant.order_issue",
    related: { type: "vendorOrder", id: vendorOrderId },
  });
}
