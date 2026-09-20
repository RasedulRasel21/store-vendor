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
