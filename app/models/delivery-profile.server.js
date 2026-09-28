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

// A zone per rate. A rate with no countries covers the rest of the world, which Shopify
// expresses as "all countries" with the others already claimed by their own zones.
function zonesToCreate(rates, currencyCode) {
  return rates.map((rate) => ({
    name: rate.countryCodes.length
      ? `${rate.name} — ${rate.countryCodes.join(", ").slice(0, 60)}`
      : `${rate.name} — everywhere else`,
    countries: rate.countryCodes.length
      ? rate.countryCodes.map((code) => ({ code }))
      : [{ restOfWorld: true }],
    methodDefinitionsToCreate: [
      {
        name: rate.name,
        active: true,
        rateDefinition: {
          price: { amount: Number(rate.price).toFixed(2), currencyCode },
        },
      },
    ],
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

  // At most one catch-all, or Shopify would have two zones claiming the same countries.
  if (clean.filter((rate) => !rate.countryCodes.length).length > 1) {
    return { errors: { form: "Only one rate can cover everywhere else." } };
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
