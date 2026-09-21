import db from "../db.server";
import { decryptSecret, encryptionAvailable, encryptSecret } from "../utils/secrets";

// Two providers that only need an API key and a verified sending address. Until one is
// set up, every message is still written to the email log, so the notifications can be
// built, tested and read now and start going out the moment a provider is connected.
export const EMAIL_PROVIDERS = {
  RESEND: { label: "Resend" },
  POSTMARK: { label: "Postmark" },
};

// Stands in for the store's own address until a verified one is set, so messages in the
// log show what the vendor would see.
export const PLACEHOLDER_FROM = "StoreVendor <no-reply@example.com>";

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

// Logs the message, then sends it if a provider is set up. Never throws: a notification
// that can't go out must not break the thing that triggered it.
export async function sendEmail(shop, { to, subject, text, template, related }) {
  if (!to || !EMAIL.test(to)) return { skipped: "No valid address" };

  const settings = await db.shopSettings.findUnique({
    where: { shop },
    select: { emailProvider: true, emailApiKey: true, emailFrom: true, emailReplyTo: true },
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

  const provider = PROVIDERS[settings?.emailProvider];
  const apiKey = decryptSecret(settings?.emailApiKey);
  if (!provider || !apiKey) {
    await db.emailMessage.update({
      where: { id: message.id },
      data: { status: "SKIPPED", error: "No email provider set up; saved to the log only." },
    });
    return { skipped: "No provider" };
  }

  try {
    const result = await provider.send(apiKey, {
      from: settings.emailFrom || PLACEHOLDER_FROM,
      replyTo: settings.emailReplyTo || null,
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

export async function connectEmail(shop, { provider, apiKey, from, replyTo }) {
  const errors = {};
  if (!PROVIDERS[provider]) errors.provider = "Choose a provider";
  if (!apiKey?.trim()) errors.apiKey = "Paste the API key";
  const fromAddress = from?.trim() ?? "";
  // "Name <address>" or a bare address.
  const address = fromAddress.match(/<([^>]+)>/)?.[1] ?? fromAddress;
  if (!EMAIL.test(address)) errors.from = "Use an address on a domain you've verified with the provider";
  if (replyTo?.trim() && !EMAIL.test(replyTo.trim())) errors.replyTo = "Use a valid email address";
  if (Object.keys(errors).length) return { errors };
  if (!encryptionAvailable()) {
    return { error: "This store can't hold API keys yet: ENCRYPTION_KEY isn't set on the server." };
  }

  let check;
  try {
    check = await PROVIDERS[provider].check(apiKey.trim());
  } catch (error) {
    console.error("Email provider check failed", error);
    return { error: "Couldn't reach the provider. Try again." };
  }
  if (check.error) return { errors: { apiKey: check.error } };

  const data = {
    emailProvider: provider,
    emailApiKey: encryptSecret(apiKey.trim()),
    emailFrom: fromAddress,
    emailReplyTo: replyTo?.trim() || null,
  };
  await db.shopSettings.upsert({ where: { shop }, update: data, create: { shop, ...data } });
  return { ok: true };
}

export async function disconnectEmail(shop) {
  const data = { emailProvider: null, emailApiKey: null, emailFrom: null, emailReplyTo: null };
  await db.shopSettings.upsert({ where: { shop }, update: data, create: { shop } });
  return { ok: true };
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
