import db from "../db.server";
import { COUNTRY_NAMES } from "../utils/countries";

// Per-vendor delivery rates, done with Shopify's own delivery profiles rather than a
// carrier service of ours.
//
// A profile holds zones, each zone holds a rate, and products are assigned to a profile.
// When a cart holds products from two profiles Shopify charges both, which is exactly
// what a marketplace wants: each vendor's own postage, added up. It also works on every
// Shopify plan and costs nothing at checkout time, where a carrier-service callback
// would have to answer in under half a second on plans that allow it at all.
//
// One profile per vendor, named after them so a merchant can recognise it in Shopify.

const PROFILE_QUERY = `#graphql
  query VendorDeliveryProfile($id: ID!) {
    deliveryProfile(id: $id) {
      id
      name
      profileLocationGroups {
        locationGroup { id }
        locationGroupZones(first: 50) {
          nodes {
            zone { id }
          }
        }
      }
    }
  }`;

const LOCATIONS_QUERY = `#graphql
  query ShippingLocations {
    locations(first: 20, includeInactive: false) {
      nodes { id }
    }
  }`;

const VARIANTS_QUERY = `#graphql
  query VendorVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        variants(first: 100) {
          nodes { id }
        }
      }
    }
  }`;

const CREATE_PROFILE = `#graphql
  mutation CreateVendorProfile($profile: DeliveryProfileInput!) {
    deliveryProfileCreate(profile: $profile) {
      profile { id }
      userErrors { field message }
    }
  }`;

const UPDATE_PROFILE = `#graphql
  mutation UpdateVendorProfile($id: ID!, $profile: DeliveryProfileInput!) {
    deliveryProfileUpdate(id: $id, profile: $profile) {
      profile { id }
      userErrors { field message }
    }
  }`;

// Shopify counts variants, not products, and a profile can't take an unbounded number in
// one call. Enough for a real vendor, small enough to stay inside one request.
const MAX_PRODUCTS = 100;

export function rateZones(rates) {
  return rates.map((rate) => ({
    name: rate.countryCodes.length
      ? rate.countryCodes.map((code) => COUNTRY_NAMES[code] ?? code).slice(0, 3).join(", ") +
        (rate.countryCodes.length > 3 ? ` +${rate.countryCodes.length - 3}` : "")
      : "Everywhere else",
    countryCodes: rate.countryCodes,
    rateName: rate.name,
    price: Number(rate.price),
  }));
}

// One zone per set of countries, with every rate for those countries inside it.
//
// A country can only belong to one zone, so a vendor who charges 60 inside Dhaka and 120
// outside it can't have two zones both claiming Bangladesh — Shopify silently gives the
// country to one of them and leaves the other covering nowhere. Both prices belong in
// the same zone instead, and the customer picks at checkout, which is also how Shopify's
// own multi-rate shipping reads.
function zonesToCreate(rates, currencyCode) {
  const byCountries = new Map();

  for (const rate of rates) {
    const codes = [...rate.countryCodes].sort();
    const key = codes.join(",");
    if (!byCountries.has(key)) byCountries.set(key, { codes, rates: [] });
    byCountries.get(key).rates.push(rate);
  }

  return [...byCountries.values()].map(({ codes, rates: zoneRates }) => ({
    name: codes.length ? codes.join(", ").slice(0, 60) : "Everywhere else",
    countries: codes.length ? codes.map((code) => ({ code })) : [{ restOfWorld: true }],
    methodDefinitionsToCreate: zoneRates.map((rate) => ({
      name: rate.name,
      active: true,
      rateDefinition: {
        price: { amount: Number(rate.price).toFixed(2), currencyCode },
      },
    })),
  }));
}

async function vendorVariantIds(admin, shop, vendorId) {
  const links = await db.vendorProduct.findMany({
    where: { shop, vendorId },
    take: MAX_PRODUCTS,
    select: { productId: true },
  });
  if (!links.length) return { variantIds: [], products: 0 };

  const response = await admin.graphql(VARIANTS_QUERY, {
    variables: { ids: links.map((link) => link.productId) },
  });
  const { data } = await response.json();

  const variantIds = (data?.nodes ?? [])
    .filter(Boolean)
    .flatMap((product) => (product.variants?.nodes ?? []).map((variant) => variant.id));

  return { variantIds, products: links.length };
}

// Brings Shopify in line with what the vendor has set. Safe to call as often as you like:
// it replaces the vendor's zones rather than adding to them.
export async function syncVendorShipping(admin, shop, vendorId) {
  const [settings, vendor, rates] = await Promise.all([
    db.shopSettings.findUnique({ where: { shop } }),
    db.vendor.findFirst({ where: { id: vendorId, shop }, select: { id: true, name: true, deliveryProfileId: true } }),
    db.vendorShippingRate.findMany({ where: { shop, vendorId }, orderBy: { createdAt: "asc" } }),
  ]);
  if (!vendor) return { error: "Vendor not found" };
  if (!settings?.vendorShippingRates) return { skipped: "Vendors don't set their own rates in this store." };

  const currencyCode = settings.currencyCode ?? "USD";
  const { variantIds, products } = await vendorVariantIds(admin, shop, vendorId);

  // No rates: their products go back to the store's own shipping rather than sitting in
  // a profile that charges nothing.
  if (!rates.length) {
    if (vendor.deliveryProfileId && variantIds.length) {
      await admin.graphql(UPDATE_PROFILE, {
        variables: {
          id: vendor.deliveryProfileId,
          profile: { variantsToDissociate: variantIds },
        },
      });
    }
    return { ok: true, zones: 0, products };
  }

  const zones = zonesToCreate(rates, currencyCode);

  if (vendor.deliveryProfileId) {
    // Read what's there so the old zones go as the new ones arrive; otherwise every save
    // would leave another set of rates behind.
    const existing = await admin.graphql(PROFILE_QUERY, { variables: { id: vendor.deliveryProfileId } });
    const { data } = await existing.json();
    const group = data?.deliveryProfile?.profileLocationGroups?.[0];

    if (group) {
      const oldZoneIds = (group.locationGroupZones?.nodes ?? []).map((node) => node.zone.id);
      const response = await admin.graphql(UPDATE_PROFILE, {
        variables: {
          id: vendor.deliveryProfileId,
          profile: {
            ...(oldZoneIds.length ? { zonesToDelete: oldZoneIds } : {}),
            locationGroupsToUpdate: [{ id: group.locationGroup.id, zonesToCreate: zones }],
            ...(variantIds.length ? { variantsToAssociate: variantIds } : {}),
          },
        },
      });
      const { data: updated } = await response.json();
      const failed = updated?.deliveryProfileUpdate?.userErrors?.[0]?.message;
      if (failed) return { error: failed };
      return { ok: true, zones: zones.length, products };
    }
    // The profile went missing in Shopify; fall through and make a new one.
  }

  const locationsResponse = await admin.graphql(LOCATIONS_QUERY);
  const { data: locationData } = await locationsResponse.json();
  const locationIds = (locationData?.locations?.nodes ?? []).map((node) => node.id);
  if (!locationIds.length) return { error: "This store has no active locations to ship from." };

  const response = await admin.graphql(CREATE_PROFILE, {
    variables: {
      profile: {
        name: `${vendor.name} shipping`.slice(0, 250),
        locationGroupsToCreate: [{ locationsToAdd: locationIds, zonesToCreate: zones }],
        ...(variantIds.length ? { variantsToAssociate: variantIds } : {}),
      },
    },
  });
  const { data } = await response.json();
  const failed = data?.deliveryProfileCreate?.userErrors?.[0]?.message;
  if (failed) return { error: failed };

  const profileId = data?.deliveryProfileCreate?.profile?.id;
  if (!profileId) return { error: "Shopify didn't create the delivery profile." };

  await db.vendor.update({ where: { id: vendor.id }, data: { deliveryProfileId: profileId } });
  return { ok: true, created: true, zones: zones.length, products };
}

const MAX_RATES = 20;

export async function saveVendorRates(shop, vendorId, rows) {
  const clean = [];
  const errors = {};

  (rows ?? []).slice(0, MAX_RATES).forEach((row, index) => {
    const name = String(row?.name ?? "").trim().slice(0, 80);
    const price = Number(row?.price);
    const countryCodes = [
      ...new Set(
        (Array.isArray(row?.countryCodes) ? row.countryCodes : [])
          .map((code) => String(code).toUpperCase().slice(0, 2))
          .filter((code) => COUNTRY_NAMES[code]),
      ),
    ];

    if (!name) errors[`rates.${index}.name`] = "Give this rate a name customers will understand";
    if (!Number.isFinite(price) || price < 0) errors[`rates.${index}.price`] = "Use a price of zero or more";
    if (Object.keys(errors).length) return;

    clean.push({ name, price: price.toFixed(2), countryCodes });
  });

  if (Object.keys(errors).length) return { errors };

  // Rates covering the same countries end up as choices in one zone, so duplicates are
  // fine — but two with the same name in the same zone would be indistinguishable at
  // checkout.
  const seen = new Set();
  for (const rate of clean) {
    const key = `${[...rate.countryCodes].sort().join(",")}|${rate.name.toLowerCase()}`;
    if (seen.has(key)) {
      return {
        errors: { form: `Two rates called "${rate.name}" cover the same places. Give them different names.` },
      };
    }
    seen.add(key);
  }

  await db.$transaction([
    db.vendorShippingRate.deleteMany({ where: { shop, vendorId } }),
    ...clean.map((rate) =>
      db.vendorShippingRate.create({
        data: { shop, vendorId, name: rate.name, price: rate.price, countryCodes: rate.countryCodes },
      }),
    ),
  ]);

  return { saved: clean.length };
}

export function vendorRates(shop, vendorId) {
  return db.vendorShippingRate.findMany({ where: { shop, vendorId }, orderBy: { createdAt: "asc" } });
}
