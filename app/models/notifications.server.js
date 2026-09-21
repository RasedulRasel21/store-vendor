import db from "../db.server";
import { formatMoney } from "../utils/money";
import { sendEmail } from "./email.server";

// What vendors are told when their money moves. Plain, short, and each one says what
// happens next, since a payout email is usually read by someone waiting on the money.

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
