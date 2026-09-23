import db from "../db.server";
import { CURRENCY_CODES } from "../utils/currencies";

// Where the day's rates come from. Both are free and need no account, so conversion works
// for every merchant out of the box, whatever their currency. They're tried in order: the
// second is there for the days the first is down, not as a different answer.
const SOURCES = [
  {
    name: "exchangerate-api.com",
    url: (base) => `https://open.er-api.com/v6/latest/${base}`,
    read: (data) => (data?.result === "success" ? data.rates : null),
    updatedAt: (data) =>
      data?.time_last_update_unix ? new Date(data.time_last_update_unix * 1000) : null,
  },
  {
    name: "currency-api",
    url: (base) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${base.toLowerCase()}.json`,
    read: (data, base) => data?.[base.toLowerCase()] ?? null,
    updatedAt: (data) => (data?.date ? new Date(`${data.date}T00:00:00Z`) : null),
  },
];

// A rate service can answer with anything: crypto, metals, a currency that no longer
// exists, a zero, a string. Only real currencies with a sane positive rate get through.
function cleanRates(raw, base) {
  const rates = {};
  for (const [code, value] of Object.entries(raw ?? {})) {
    const upper = code.toUpperCase();
    if (upper === base || !CURRENCY_CODES.has(upper)) continue;

    const rate = Number(value);
    // A rate of 0, a negative one, or one so extreme it can only be a mistake is not money.
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1e9) continue;
    rates[upper] = String(rate);
  }
  return rates;
}

// The day's rates for one unit of the shop's currency. Never throws.
export async function fetchRates(base) {
  const code = String(base ?? "").toUpperCase();
  if (!CURRENCY_CODES.has(code)) return { error: `${base} isn't a currency we can fetch rates for` };

  const failures = [];
  for (const source of SOURCES) {
    try {
      const response = await fetch(source.url(code), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        failures.push(`${source.name} answered ${response.status}`);
        continue;
      }

      const data = await response.json();
      const rates = cleanRates(source.read(data, code), code);
      // A handful of rates means something is wrong with the answer, not with the world.
      if (Object.keys(rates).length < 20) {
        failures.push(`${source.name} sent too few rates`);
        continue;
      }

      return { rates, source: source.name, ratesAt: source.updatedAt(data) ?? new Date() };
    } catch (error) {
      console.error(`Rate lookup failed at ${source.name}`, error);
      failures.push(`Couldn't reach ${source.name}`);
    }
  }

  return { error: failures.join("; ") || "No rate service answered" };
}

// Fetches and stores. Rates are kept rather than looked up when a payout is made, so a
// payout can never wait on someone else's server, and so the rate used is one the merchant
// could have seen beforehand.
export async function refreshRates(shop, { base } = {}) {
  const settings = await db.shopSettings.findUnique({
    where: { shop },
    select: { currencyCode: true },
  });
  const code = base ?? settings?.currencyCode;
  if (!code) return { error: "This store's currency isn't known yet" };

  const result = await fetchRates(code);
  if (result.error) return result;

  await db.shopSettings.upsert({
    where: { shop },
    update: {
      payoutFxRates: result.rates,
      payoutFxRatesAt: result.ratesAt,
      payoutFxBase: code,
      payoutFxSource: result.source,
    },
    create: {
      shop,
      payoutFxRates: result.rates,
      payoutFxRatesAt: result.ratesAt,
      payoutFxBase: code,
      payoutFxSource: result.source,
    },
  });

  return { count: Object.keys(result.rates).length, source: result.source, ratesAt: result.ratesAt };
}

const DAY = 24 * 60 * 60 * 1000;

// Rates more than two days old are worth saying out loud: either the service has been
// down, or automatic updates are off and nobody has touched them.
export function ratesAreStale(settings) {
  if (!settings?.payoutFxRatesAt) return Boolean(settings?.payoutFxRates);
  return Date.now() - new Date(settings.payoutFxRatesAt).getTime() > 2 * DAY;
}

// The stored rates are only usable if they were fetched for the currency the shop is in
// now. A merchant who switches their store currency gets no conversion until they refresh,
// rather than payouts quietly converted at the old currency's rates.
export function ratesMatchCurrency(settings, shopCurrency) {
  if (!settings?.payoutFxBase) return true;
  return settings.payoutFxBase === shopCurrency;
}

// Every store that converts payouts and wants its rates kept up to date. Run daily.
export async function refreshEveryShopsRates() {
  const shops = await db.shopSettings.findMany({
    where: { payoutFxEnabled: true, payoutFxAuto: true, currencyCode: { not: null } },
    select: { shop: true, currencyCode: true },
  });

  let updated = 0;
  const failed = [];
  for (const row of shops) {
    const result = await refreshRates(row.shop, { base: row.currencyCode });
    if (result.error) failed.push(`${row.shop}: ${result.error}`);
    else updated += 1;
  }

  if (failed.length) console.error("Rate refresh failed for some shops", failed);
  return { shops: shops.length, updated, failed: failed.length };
}
