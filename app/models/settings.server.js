import db from "../db.server";
import { parseCommission } from "../utils/commission";

const SHOP_CURRENCY = `#graphql
  query ShopCurrency {
    shop {
      currencyCode
      shopAddress {
        countryCodeV2
      }
    }
  }`;

export function getShopSettings(shop) {
  return db.shopSettings.upsert({ where: { shop }, update: {}, create: { shop } });
}

async function getShopBasics(admin) {
  const response = await admin.graphql(SHOP_CURRENCY);
  const { data } = await response.json();

  return {
    currencyCode: data?.shop?.currencyCode ?? "USD",
    countryCode: data?.shop?.shopAddress?.countryCodeV2 ?? null,
  };
}

export async function getShopCurrency(admin) {
  const { currencyCode } = await getShopBasics(admin);
  return currencyCode;
}

// Saves the shop's currency and country once: the portal shows prices in the currency, and
// the country decides which carriers Shopify offers for tracking.
export async function ensureShopCurrency(admin, shop) {
  const settings = await getShopSettings(shop);
  if (settings.currencyCode && settings.countryCode) return settings.currencyCode;

  const { currencyCode, countryCode } = await getShopBasics(admin);
  await db.shopSettings.update({ where: { shop }, data: { currencyCode, countryCode } });
  return currencyCode;
}

// How long a vendor has to ship before the order is chased. Kept sane so a typo can't
// make every order overdue at once, or never.
export async function updateFulfillmentDays(shop, input) {
  const days = Math.trunc(Number(input));
  if (!Number.isFinite(days) || days < 1 || days > 60) {
    return { error: "Choose between 1 and 60 days" };
  }

  await db.shopSettings.upsert({
    where: { shop },
    update: { fulfillmentDays: days },
    create: { shop, fulfillmentDays: days },
  });

  return { days };
}

const SHOP_LOCATIONS = `#graphql
  query ShopLocations {
    locations(first: 50, includeInactive: false) {
      nodes {
        id
        name
        fulfillsOnlineOrders
      }
    }
  }`;

export async function shopLocations(admin) {
  const response = await admin.graphql(SHOP_LOCATIONS);
  const { data } = await response.json();
  return data?.locations?.nodes ?? [];
}

// Where returned stock goes back on the shelf. Vendors can't restock until it's set,
// because the app shouldn't guess which of a merchant's locations to credit.
export async function updateRestockLocation(shop, locationId, locations) {
  if (!locationId) {
    await db.shopSettings.upsert({
      where: { shop },
      update: { restockLocationId: null, restockLocationName: null },
      create: { shop },
    });
    return { cleared: true };
  }

  const location = locations.find((candidate) => candidate.id === locationId);
  if (!location) return { error: "That location isn't in this store" };

  await db.shopSettings.upsert({
    where: { shop },
    update: { restockLocationId: location.id, restockLocationName: location.name },
    create: { shop, restockLocationId: location.id, restockLocationName: location.name },
  });

  return { location };
}

// The hold, the minimum and whether vendors can ask. Bounded so a typo can't release
// money the day it's taken, or hold it for a year.
export const PAYOUT_SCHEDULES = ["MANUAL", "WEEKLY", "MONTHLY"];

export async function updatePayoutSettings(shop, { holdDays, minimum, requests, schedule, refundKeepsCommission }) {
  const days = Math.trunc(Number(holdDays));
  const floor = Number(minimum);
  const errors = {};
  if (!Number.isFinite(days) || days < 0 || days > 90) errors.holdDays = "Choose between 0 and 90 days";
  if (!Number.isFinite(floor) || floor < 0) errors.minimum = "Use zero or more";
  if (!PAYOUT_SCHEDULES.includes(schedule)) errors.schedule = "Choose when payouts are made";
  if (Object.keys(errors).length) return { errors };

  const data = {
    payoutHoldDays: days,
    payoutMinimum: floor.toFixed(2),
    payoutRequests: Boolean(requests),
    payoutSchedule: schedule,
    // Only orders placed from now on follow a change; older ones keep the rule they had.
    refundKeepsCommission: Boolean(refundKeepsCommission),
  };
  await db.shopSettings.upsert({ where: { shop }, update: data, create: { shop, ...data } });
  return { saved: true };
}

// The store as a seller on commission invoices. Blank fields are allowed: invoices print a
// clear placeholder for them until they're filled in.
export async function updateInvoiceSettings(shop, input) {
  const text = (value, max) => String(value ?? "").trim().slice(0, max);
  const rate = Number(input.taxRate);
  const prefix = text(input.prefix, 12);
  const errors = {};
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) errors.taxRate = "Use a rate between 0 and 100";
  if (!/^[A-Za-z0-9-]{1,12}$/.test(prefix)) errors.prefix = "Letters, numbers and dashes, up to 12";
  if (Object.keys(errors).length) return { errors };

  const data = {
    businessName: text(input.businessName, 200) || null,
    businessAddress: text(input.businessAddress, 500) || null,
    businessTaxId: text(input.businessTaxId, 60) || null,
    taxLabel: text(input.taxLabel, 20) || "VAT",
    commissionTaxRate: rate.toFixed(2),
    invoicePrefix: prefix,
    autoInvoices: Boolean(input.autoInvoices),
  };
  await db.shopSettings.upsert({ where: { shop }, update: data, create: { shop, ...data } });
  return { saved: true };
}

export function dismissSetupGuide(shop) {
  const now = new Date();
  return db.shopSettings.upsert({
    where: { shop },
    update: { setupGuideDismissedAt: now },
    create: { shop, setupGuideDismissedAt: now },
  });
}

export async function updateDefaultCommission(shop, input) {
  const result = parseCommission(input);
  if (result.errors) return { errors: result.errors };

  const settings = await db.shopSettings.upsert({
    where: { shop },
    update: result.values,
    create: { shop, ...result.values },
  });

  return { settings };
}
