import db from "../db.server";
import { decryptSecret, encryptionAvailable, encryptSecret } from "../utils/secrets";
import { checkPaypal, paypalStatus, sendPaypal } from "./payout-rails/paypal.server";
import {
  checkStripe,
  createVendorAccount,
  onboardingLink,
  sendStripe,
  vendorAccountStatus,
} from "./payout-rails/stripe.server";
import { cancelPayout, markPayoutPaid } from "./payout.server";

// Automatic payout rails. Money always moves from the merchant's own PayPal or Stripe
// account; the app holds encrypted credentials, never funds. A payout goes through a rail
// only when the vendor's approved payout method matches one the merchant has connected,
// and anything a rail can't do leaves the payout as it was, to be sent by hand.

export async function connectPaypal(shop, { clientId, secret, mode }) {
  const errors = {};
  if (!clientId?.trim()) errors.clientId = "Paste the client ID";
  if (!secret?.trim()) errors.secret = "Paste the secret";
  if (!["sandbox", "live"].includes(mode)) errors.mode = "Choose sandbox or live";
  if (Object.keys(errors).length) return { errors };
  if (!encryptionAvailable()) return { error: "ENCRYPTION_KEY isn't set on the server, so credentials can't be stored." };

  const credentials = { clientId: clientId.trim(), secret: secret.trim(), mode };
  let check;
  try {
    check = await checkPaypal(credentials);
  } catch (error) {
    console.error("PayPal check failed", error);
    return { error: "Couldn't reach PayPal. Try again." };
  }
  if (check.error) return { errors: { secret: check.error } };

  const data = {
    paypalMode: mode,
    paypalCredentials: encryptSecret(JSON.stringify({ clientId: credentials.clientId, secret: credentials.secret })),
    paypalAccount: check.account,
  };
  await db.shopSettings.upsert({ where: { shop }, update: data, create: { shop, ...data } });
  return { ok: true };
}

export async function connectStripe(shop, { secretKey }) {
  const key = secretKey?.trim() ?? "";
  if (!key) return { errors: { secretKey: "Paste the secret key" } };
  if (!encryptionAvailable()) return { error: "ENCRYPTION_KEY isn't set on the server, so credentials can't be stored." };

  let check;
  try {
    check = await checkStripe(key);
  } catch (error) {
    console.error("Stripe check failed", error);
    return { error: "Couldn't reach Stripe. Try again." };
  }
  if (check.error) return { errors: { secretKey: check.error } };

  const data = { stripeSecretKey: encryptSecret(key), stripeAccount: check.account };
  await db.shopSettings.upsert({ where: { shop }, update: data, create: { shop, ...data } });
  return { ok: true };
}

export async function disconnectRail(shop, rail) {
  const data =
    rail === "PAYPAL"
      ? { paypalMode: null, paypalCredentials: null, paypalAccount: null }
      : { stripeSecretKey: null, stripeAccount: null };
  await db.shopSettings.upsert({ where: { shop }, update: data, create: { shop } });
  return { ok: true };
}

function railCredentials(settings) {
  const paypal = decryptSecret(settings?.paypalCredentials);
  return {
    paypal: paypal ? { ...JSON.parse(paypal), mode: settings.paypalMode ?? "sandbox" } : null,
    stripe: decryptSecret(settings?.stripeSecretKey),
  };
}

// Which rail, if any, can send this payout.
export function railFor(payout, connected) {
  if (payout.method === "PAYPAL" && connected.paypal) return "PAYPAL";
  if (payout.method === "STRIPE" && connected.stripe) return "STRIPE";
  return null;
}

export async function connectedRails(shop) {
  const settings = await db.shopSettings.findUnique({
    where: { shop },
    select: { paypalCredentials: true, stripeSecretKey: true },
  });
  return { paypal: Boolean(settings?.paypalCredentials), stripe: Boolean(settings?.stripeSecretKey) };
}

export async function sendPayout(shop, payoutId, actor) {
  const [payout, settings] = await Promise.all([
    db.payout.findFirst({ where: { id: payoutId, shop }, include: { vendor: { select: { name: true } } } }),
    db.shopSettings.findUnique({ where: { shop } }),
  ]);
  if (!payout) return { error: "Payout not found" };
  if (payout.status !== "PENDING") return { error: "Only a payout waiting to be sent can be sent" };
  if (payout.providerRef) return { error: "This payout has already gone out; check its status instead" };

  const credentials = railCredentials(settings);
  const rail = railFor(payout, { paypal: Boolean(credentials.paypal), stripe: Boolean(credentials.stripe) });
  if (!rail) return { error: "No connected rail can send this payout. Send it by hand and mark it sent." };

  const destination = payout.details?.accountNumber;
  if (!destination) return { error: "The payout has no account to send to" };

  // A Stripe transfer only ever goes to the account the store's own platform created for
  // this vendor, whatever the payout details say.
  if (rail === "STRIPE") {
    const vendor = await db.vendor.findUnique({ where: { id: payout.vendorId }, select: { stripeAccountId: true } });
    if (!vendor?.stripeAccountId || vendor.stripeAccountId !== destination) {
      return { error: "That Stripe account isn't the one this vendor set up with your platform. Ask them to reconnect Stripe." };
    }
  }

  // Converted payouts go out in the vendor's currency; everyone else in the shop's.
  const currency = payout.payoutCurrency ?? payout.currencyCode;
  const amount = Number(payout.payoutAmount ?? payout.amount).toFixed(2);
  const note = `Payout from ${settings?.businessName || shop.replace(/\.myshopify\.com$/, "")}`;

  let result;
  try {
    result =
      rail === "PAYPAL"
        ? await sendPaypal(credentials.paypal, { payoutId: payout.id, receiver: destination, amount, currency, note })
        : await sendStripe(credentials.stripe, { payoutId: payout.id, destination, amount, currency, description: note });
  } catch (error) {
    console.error(`${rail} send failed`, error);
    return { error: `Couldn't reach ${rail === "PAYPAL" ? "PayPal" : "Stripe"}. Nothing was sent; try again.` };
  }
  if (result.error) return { error: result.error };

  await db.payout.update({
    where: { id: payout.id },
    data: { provider: rail, providerRef: result.ref, providerStatus: result.status, sentAt: new Date() },
  });
  await db.vendorActivity.create({
    data: { vendorId: payout.vendorId, action: "payout.sent_by_rail", actor, details: { rail, ref: result.ref } },
  });

  // Stripe settles on the spot. PayPal confirms later, so it stays waiting until it does.
  if (result.status === "PAID") await markPayoutPaid(shop, payout.id, { reference: result.ref, actor });
  return { ok: true, rail, settled: result.status === "PAID" };
}

// Asks PayPal how a payout it's holding is doing, and settles it either way when it knows.
export async function refreshPayout(shop, payoutId) {
  const [payout, settings] = await Promise.all([
    db.payout.findFirst({ where: { id: payoutId, shop } }),
    db.shopSettings.findUnique({ where: { shop } }),
  ]);
  if (!payout || payout.status !== "PENDING" || payout.provider !== "PAYPAL" || !payout.providerRef) {
    return { skipped: true };
  }

  const { paypal } = railCredentials(settings);
  if (!paypal) return { error: "PayPal isn't connected any more" };

  const status = await paypalStatus(paypal, payout.providerRef);
  if (status.error) return status;

  await db.payout.update({ where: { id: payout.id }, data: { providerStatus: status.status } });
  if (status.outcome === "PAID") {
    await markPayoutPaid(shop, payout.id, { reference: status.reference ?? payout.providerRef, actor: "paypal" });
  } else if (status.outcome === "FAILED") {
    await cancelPayout(shop, payout.id, {
      note: `PayPal couldn't pay it (${status.status}${status.reason ? `: ${status.reason}` : ""})`,
      actor: "paypal",
    });
  }
  return { outcome: status.outcome, status: status.status };
}

export async function refreshInFlight(shop) {
  const waiting = await db.payout.findMany({
    where: { shop, status: "PENDING", provider: "PAYPAL", providerRef: { not: null } },
    select: { id: true },
  });
  const results = [];
  for (const { id } of waiting) results.push(await refreshPayout(shop, id));
  return { checked: waiting.length, settled: results.filter((row) => row.outcome && row.outcome !== "PENDING").length };
}

// When the merchant has chosen to, payouts go out through a rail as soon as they're set
// aside. Failures leave them waiting to be sent by hand, as if this were off.
export async function autoSend(shop, payoutIds) {
  const settings = await db.shopSettings.findUnique({ where: { shop }, select: { autoSendPayouts: true } });
  if (!settings?.autoSendPayouts || !payoutIds.length) return { sent: 0 };

  const connected = await connectedRails(shop);
  const payouts = await db.payout.findMany({ where: { id: { in: payoutIds }, shop }, select: { id: true, method: true } });

  let sent = 0;
  for (const payout of payouts) {
    if (!railFor(payout, connected)) continue;
    const result = await sendPayout(shop, payout.id, "auto");
    if (result.ok) sent += 1;
  }
  return { sent };
}

// ---- Stripe onboarding for vendors, called from the portal ----

async function vendorWithStripe(vendorId) {
  const vendor = await db.vendor.findUnique({
    where: { id: vendorId },
    select: { id: true, shop: true, email: true, countryCode: true, taxInfo: true, stripeAccountId: true },
  });
  if (!vendor) return { error: "Vendor not found" };

  const settings = await db.shopSettings.findUnique({ where: { shop: vendor.shop }, select: { stripeSecretKey: true } });
  const key = decryptSecret(settings?.stripeSecretKey);
  return { vendor, key };
}

export async function stripeVendorStatus(vendorId) {
  const { vendor, key, error } = await vendorWithStripe(vendorId);
  if (error) return { error };
  if (!key) return { available: false };
  if (!vendor.stripeAccountId) return { available: true, accountId: null };

  const status = await vendorAccountStatus(key, vendor.stripeAccountId);
  if (status.error) return { available: true, accountId: vendor.stripeAccountId, error: status.error };
  return { available: true, accountId: vendor.stripeAccountId, ...status };
}

export async function stripeOnboarding(vendorId, { returnUrl, refreshUrl }) {
  const { vendor, key, error } = await vendorWithStripe(vendorId);
  if (error) return { error };
  if (!key) return { error: "The store hasn't connected Stripe." };

  let accountId = vendor.stripeAccountId;
  if (!accountId) {
    const created = await createVendorAccount(key, {
      email: vendor.email,
      countryCode: vendor.taxInfo?.countryCode ?? vendor.countryCode ?? null,
      vendorId: vendor.id,
    });
    if (created.error) return created;
    accountId = created.accountId;
    await db.vendor.update({ where: { id: vendor.id }, data: { stripeAccountId: accountId } });
  }

  return onboardingLink(key, { accountId, returnUrl, refreshUrl });
}
