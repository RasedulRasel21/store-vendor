import crypto from "node:crypto";
import db from "../db.server";

// Where things that go wrong are written down.
//
// A console line disappears the moment a serverless function finishes, so anything that
// fails in the night is invisible by morning. Every failure lands here instead: grouped so
// the same fault is one row with a count, kept with enough detail to fix it, and shown to
// the merchant in plain words on the health page when it is their shop that was affected.
//
// Sending them on to an outside service is one environment variable away, and nothing here
// depends on having one.

// Two of the same fault mention different order numbers, so the ids and numbers come out
// before the message is hashed and the pair lands on one row.
function fingerprintOf(source, context, message) {
  const shape = String(message ?? "")
    .toLowerCase()
    .replace(/gid:\/\/shopify\/\w+\/\d+/g, "<gid>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<id>")
    .replace(/\b(?:c[a-z0-9]{24}|[0-9a-f]{24,})\b/g, "<id>")
    .replace(/\b\d[\d.,]*\b/g, "<n>")
    .slice(0, 300);

  return crypto.createHash("sha256").update(`${source}|${context}|${shape}`).digest("hex").slice(0, 32);
}

const MESSAGE_MAX = 1000;
const STACK_MAX = 6000;

function readError(error) {
  if (!error) return { message: "Something failed without saying what", stack: null };
  if (typeof error === "string") return { message: error.slice(0, MESSAGE_MAX), stack: null };

  const stack = typeof error.stack === "string" ? error.stack.slice(0, STACK_MAX) : null;
  if (typeof error.message === "string" && error.message) {
    return { message: error.message.slice(0, MESSAGE_MAX), stack };
  }

  // Not everything thrown is an Error. A response, a string in a wrapper, a plain object:
  // "[object Object]" in the log helps nobody, so it gets read for whatever it does say.
  if (typeof error.status === "number") {
    const detail = typeof error.data === "string" ? error.data : error.statusText;
    return { message: `${error.status} ${detail ?? ""}`.trim().slice(0, MESSAGE_MAX), stack };
  }

  const described = (() => {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  })();
  return { message: (described ?? String(error)).slice(0, MESSAGE_MAX), stack };
}

// An hour between pings for the same fault. A loop that fails every minute is worth one
// message, not sixty.
const ALERT_EVERY_MS = 60 * 60 * 1000;

async function alert(event) {
  // eslint-disable-next-line no-undef
  const url = process.env.ERROR_ALERT_WEBHOOK;
  if (!url) return;

  const line =
    `⚠️ ${event.source} · ${event.context}` +
    `${event.shop ? ` · ${event.shop}` : ""}` +
    `\n${event.message}` +
    `${event.count > 1 ? `\n(${event.count} times so far)` : ""}`;

  try {
    // Slack reads "text", Discord reads "content", and each ignores the other's field, so
    // one body works with whichever webhook is pasted in.
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: line, content: line }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // An alert that can't be delivered must never take down the thing it was reporting on.
  }
}

/**
 * Writes a failure down. Never throws: it is called from catch blocks, and a reporter that
 * fails takes the real error with it.
 *
 * @param {unknown} error the thrown thing
 * @param {object} where
 * @param {string} where.context where it happened: "webhook:orders/create", "cron:nightly"
 * @param {string} [where.source] "app" (default) or "portal"
 * @param {string} [where.shop] the affected shop, when a merchant would want to know
 * @param {string} [where.vendorId]
 * @param {object} [where.details] small, non-personal extras: an order id, an intent
 */
export async function reportError(error, { context, source = "app", shop, vendorId, details } = {}) {
  const { message, stack } = readError(error);
  const where = context || "unknown";

  // Still in the platform log, where a live tail can see it as it happens.
  console.error(`[${source}] ${where}${shop ? ` (${shop})` : ""}: ${message}`);

  const fingerprint = fingerprintOf(source, where, message);

  try {
    const event = await db.errorEvent.upsert({
      where: { fingerprint },
      create: {
        fingerprint,
        source,
        context: where,
        shop: shop ?? null,
        vendorId: vendorId ?? null,
        message,
        stack,
        details: details ?? undefined,
      },
      update: {
        count: { increment: 1 },
        lastSeenAt: new Date(),
        message,
        stack,
        shop: shop ?? null,
        vendorId: vendorId ?? null,
        details: details ?? undefined,
        // Coming back after it was cleared means it isn't fixed.
        resolvedAt: null,
      },
    });

    const quiet = event.alertedAt && Date.now() - event.alertedAt.getTime() < ALERT_EVERY_MS;
    if (!quiet) {
      await alert(event);
      await db.errorEvent.update({ where: { id: event.id }, data: { alertedAt: new Date() } });
    }

    return fingerprint;
  } catch (failure) {
    console.error("Couldn't record an error", failure);
    return null;
  }
}

// Wraps a piece of work so a failure is recorded and then handed on, leaving the caller to
// decide what the customer sees.
export async function reporting(where, work) {
  try {
    return await work();
  } catch (error) {
    await reportError(error, where);
    throw error;
  }
}

export function shopErrors(shop, { limit = 25, includeResolved = false } = {}) {
  return db.errorEvent.findMany({
    where: { shop, ...(includeResolved ? {} : { resolvedAt: null }) },
    orderBy: { lastSeenAt: "desc" },
    take: limit,
  });
}

export function resolveError(shop, id) {
  // Scoped to the shop so one merchant can't clear another's.
  return db.errorEvent.updateMany({ where: { id, shop }, data: { resolvedAt: new Date() } });
}

// Cleared a fortnight ago, or last seen three months ago and never since.
const KEEP_RESOLVED_DAYS = 14;
const KEEP_DAYS = 90;
const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

export function pruneErrorEvents() {
  return db.errorEvent.deleteMany({
    where: {
      OR: [
        { resolvedAt: { lt: daysAgo(KEEP_RESOLVED_DAYS) } },
        { lastSeenAt: { lt: daysAgo(KEEP_DAYS) } },
      ],
    },
  });
}
