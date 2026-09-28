import crypto from "node:crypto";
import db from "../db.server";
import { sendEmail } from "../models/email.server";
import {
  notifyMerchantChangeRequested,
  notifyMerchantOrderIssue,
  notifyMerchantProductSubmitted,
} from "../models/notifications.server";

// Emails the portal asks for.
//
// The portal writes its own rows — a product sent for approval, a payout detail change, a
// problem with an order — but it has no email account of its own, and shouldn't: one
// sender, one log, one set of words. So it says what happened and this composes and sends.
function authorized(request) {
  // eslint-disable-next-line no-undef
  const secret = process.env.PORTAL_SYNC_SECRET;
  const provided = request.headers.get("x-storevendor-secret") ?? "";
  if (!secret || provided.length !== secret.length) return false;

  // eslint-disable-next-line no-undef
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
}

const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!authorized(request)) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const intent = text(body?.intent, 40);

  // A reset link is the one message that arrives before anyone is signed in, so it is
  // found by address rather than by vendor. Nothing is said back about whether the
  // address exists: the portal answers the same way either way.
  if (intent === "password-reset") {
    const email = text(body?.email, 200).toLowerCase();
    const url = text(body?.url, 500);
    if (!email || !url) return Response.json({ error: "Missing email or link" }, { status: 400 });

    const user = await db.vendorUser.findFirst({
      where: { email, status: "ACTIVE" },
      select: { name: true, vendor: { select: { shop: true, name: true } } },
    });
    if (!user) return Response.json({ ok: true });

    await sendEmail(user.vendor.shop, {
      to: email,
      subject: "Set a new password for the seller portal",
      text: [
        user.name ? `Hi ${user.name},` : "Hello,",
        `Someone asked to reset the password for your ${user.vendor.name} seller account.`,
        `Set a new one here:\n${url}`,
        "The link runs out in an hour and works once. If this wasn't you, ignore this email — nothing has changed.",
      ].join("\n\n"),
      template: "portal.password_reset",
    });

    return Response.json({ ok: true });
  }

  const vendorId = text(body?.vendorId, 100);
  if (!vendorId) return Response.json({ error: "Missing vendor" }, { status: 400 });

  const vendor = await db.vendor.findUnique({
    where: { id: vendorId },
    select: { id: true, shop: true, name: true, status: true },
  });
  if (!vendor || vendor.status !== "ACTIVE") {
    return Response.json({ error: "Vendor not found" }, { status: 404 });
  }

  if (intent === "product-submitted") {
    const submissionId = text(body?.submissionId, 100);
    const submission = await db.productSubmission.findFirst({
      where: { id: submissionId, shop: vendor.shop, vendorId: vendor.id },
      select: { id: true, title: true },
    });
    if (!submission) return Response.json({ error: "Product not found" }, { status: 404 });

    await notifyMerchantProductSubmitted(vendor.shop, submission.id, {
      vendorName: vendor.name,
      title: submission.title,
      edit: body?.edit === true,
    });
    return Response.json({ ok: true });
  }

  if (intent === "change-requested") {
    const changeId = text(body?.changeId, 100);
    const change = await db.vendorChangeRequest.findFirst({
      where: { id: changeId, shop: vendor.shop, vendorId: vendor.id },
      select: { id: true },
    });
    if (!change) return Response.json({ error: "Request not found" }, { status: 404 });

    await notifyMerchantChangeRequested(vendor.shop, change.id, vendor.name);
    return Response.json({ ok: true });
  }

  if (intent === "order-issue") {
    const vendorOrderId = text(body?.vendorOrderId, 100);
    const order = await db.vendorOrder.findFirst({
      where: { id: vendorOrderId, shop: vendor.shop, vendorId: vendor.id },
      select: { id: true, orderName: true },
    });
    if (!order) return Response.json({ error: "Order not found" }, { status: 404 });

    await notifyMerchantOrderIssue(vendor.shop, order.id, {
      vendorName: vendor.name,
      orderName: order.orderName,
      reason: text(body?.reason, 100) || "a problem",
      note: text(body?.note, 500) || null,
    });
    return Response.json({ ok: true });
  }

  if (intent === "team-invite") {
    const email = text(body?.email, 200).toLowerCase();
    const url = text(body?.url, 500);
    const invitedBy = text(body?.invitedBy, 200);
    if (!email || !url) return Response.json({ error: "Missing email or link" }, { status: 400 });

    // Only someone this vendor has actually invited, so the endpoint can't be used to send
    // mail to any address at all.
    const invited = await db.vendorUser.findFirst({
      where: { email, vendorId: vendor.id, status: "INVITED" },
      select: { id: true },
    });
    if (!invited) return Response.json({ error: "Nobody by that address has been invited" }, { status: 404 });

    await sendEmail(vendor.shop, {
      to: email,
      subject: `Join ${vendor.name} on the seller portal`,
      text: [
        "Hello,",
        `${invitedBy || "Someone at " + vendor.name} has asked you to join their team on the seller portal, where they manage their products and orders.`,
        `Choose a password and you're in:\n${url}`,
        "The link works once, and runs out in a week.",
      ].join("\n\n"),
      template: "portal.team_invite",
    });

    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};
