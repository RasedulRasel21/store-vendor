import db from "../db.server";

// StoreVendor sends every store's vendor emails through one account of ours, the way
// Shopify apps normally do: merchants shouldn't have to hold an email provider account,
// and most don't have one. Set once for the whole app:
//
//   EMAIL_PROVIDER  RESEND or POSTMARK
//   EMAIL_API_KEY   that provider's key
//   EMAIL_FROM      an address on our own verified domain
//
// Each message still goes out under the store's name, with replies going back to the
// store, so vendors see who it's really from. Without those variables nothing is sent and
// every message is kept in the email log instead, so nothing is lost.
export function emailAccount() {
  const provider = process.env.EMAIL_PROVIDER;
  const apiKey = process.env.EMAIL_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!provider || !apiKey || !from) return null;
  return { provider, apiKey, from };
}

const PROVIDERS = {
  RESEND: {
    async check(apiKey) {
      const response = await fetch("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return response.ok ? { ok: true } : { error: "Resend didn't accept that key" };
    },
    async send(apiKey, message) {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html ?? undefined,
          reply_to: message.replyTo ?? undefined,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) return { error: data?.message ?? `Resend answered ${response.status}` };
      return { providerId: data?.id ?? null };
    },
  },
  POSTMARK: {
    async check(apiKey) {
      const response = await fetch("https://api.postmarkapp.com/server", {
        headers: { Accept: "application/json", "X-Postmark-Server-Token": apiKey },
      });
      return response.ok ? { ok: true } : { error: "Postmark didn't accept that server token" };
    },
    async send(apiKey, message) {
      const response = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": apiKey,
        },
        body: JSON.stringify({
          From: message.from,
          To: message.to,
          Subject: message.subject,
          TextBody: message.text,
          HtmlBody: message.html ?? undefined,
          ReplyTo: message.replyTo ?? undefined,
          MessageStream: "outbound",
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ErrorCode) {
        return { error: data?.Message ?? `Postmark answered ${response.status}` };
      }
      return { providerId: data?.MessageID ?? null };
    },
  },
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// A plain paragraph-per-line HTML version, so clients that prefer HTML get the same words.
function toHtml(text) {
  const escape = (value) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return text
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 16px;font:15px/1.5 sans-serif;color:#16201b">${escape(block).replaceAll("\n", "<br>")}</p>`)
    .join("");
}

// The store's name in front of our address, so a vendor sees who it's from while it's
// still sent from a domain we've verified with the provider.
function senderFor(shop, settings, account) {
  const name = settings?.businessName || settings?.shopName || shop.replace(/\.myshopify\.com$/, "");
  const address = account.from.match(/<([^>]+)>/)?.[1] ?? account.from;
  return `${name.replace(/[<>"]/g, "")} <${address}>`;
}

// Logs the message, then sends it if the app has an email account. Never throws: a
// notification that can't go out must not break the thing that triggered it.
export async function sendEmail(shop, { to, subject, text, template, related }) {
  if (!to || !EMAIL.test(to)) return { skipped: "No valid address" };

  const settings = await db.shopSettings.findUnique({
    where: { shop },
    select: { businessName: true, shopName: true, shopEmail: true },
  });
  const message = await db.emailMessage.create({
    data: {
      shop,
      to,
      subject,
      text,
      html: toHtml(text),
      template,
      relatedType: related?.type ?? null,
      relatedId: related?.id ?? null,
    },
  });

  const account = emailAccount();
  const provider = PROVIDERS[account?.provider];
  if (!account || !provider) {
    await db.emailMessage.update({
      where: { id: message.id },
      data: { status: "SKIPPED", error: "Email isn't switched on for this app yet; saved to the log only." },
    });
    return { skipped: "No provider" };
  }

  try {
    const result = await provider.send(account.apiKey, {
      from: senderFor(shop, settings, account),
      // Vendors reply to the store, not to us.
      replyTo: settings?.shopEmail || null,
      to,
      subject,
      text,
      html: toHtml(text),
    });
    await db.emailMessage.update({
      where: { id: message.id },
      data: result.error
        ? { status: "FAILED", error: result.error.slice(0, 500) }
        : { status: "SENT", providerId: result.providerId, sentAt: new Date() },
    });
    return result.error ? { error: result.error } : { sent: true };
  } catch (error) {
    console.error("Email send failed", error);
    await db.emailMessage.update({
      where: { id: message.id },
      data: { status: "FAILED", error: "Couldn't reach the email provider" },
    });
    return { error: "Couldn't reach the email provider" };
  }
}

// Checks our own key at startup or from a health check, so a bad key shows up here
// rather than as a run of failed messages.
export async function checkEmailAccount() {
  const account = emailAccount();
  if (!account) return { ok: false, error: "EMAIL_PROVIDER, EMAIL_API_KEY and EMAIL_FROM aren't set" };

  const provider = PROVIDERS[account.provider];
  if (!provider) return { ok: false, error: `EMAIL_PROVIDER must be one of ${Object.keys(PROVIDERS).join(", ")}` };

  const address = account.from.match(/<([^>]+)>/)?.[1] ?? account.from;
  if (!EMAIL.test(address)) return { ok: false, error: "EMAIL_FROM isn't a valid address" };

  try {
    return await provider.check(account.apiKey);
  } catch (error) {
    console.error("Email provider check failed", error);
    return { ok: false, error: "Couldn't reach the email provider" };
  }
}

export function recentEmails(shop, take = 25) {
  return db.emailMessage.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      to: true,
      subject: true,
      text: true,
      template: true,
      status: true,
      error: true,
      createdAt: true,
    },
  });
}
