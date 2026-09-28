import db from "../db.server";
import { COUNTRY_NAMES } from "../utils/countries";

// Per-vendor delivery rates, done with Shopify's own delivery profiles rather than a
// carrier service of ours.
//
// A profile holds zones, each zone holds the options a customer can pick, and products
// are assigned to a profile. When a cart holds products from two profiles Shopify charges
// both, which is exactly what a marketplace wants: each vendor's own postage, added up.
// It also works on every Shopify plan and costs nothing at checkout time, where a
// carrier-service callback would have to answer in under half a second, on the plans that
// allow one at all.
//
// A vendor's zones are shaped the same way Shopify shapes its own, so what they fill in
// is what a merchant would recognise in Shopify's own shipping settings.

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

const MAX_ZONES = 20;
const MAX_RATES_PER_ZONE = 10;

// A zone maps straight onto a Shopify zone, with its options inside it. There used to be
// grouping logic here to work zones out from a flat list of rates; keeping the same shape
// as Shopify made it unnecessary.
function zonesToCreate(zones, currencyCode) {
  return zones.map((zone) => ({
    name: zone.name.slice(0, 60),
    // includeAllProvinces on every country, because Shopify refuses a country that has
    // provinces ("United States must have at least one province associated") unless you
    // either list them or say all of them. Countries with no provinces, Bangladesh among
    // them, accept it happily — tested against a real store both ways.
    countries: zone.countryCodes.length
      ? zone.countryCodes.map((code) => ({ code, includeAllProvinces: true }))
      : [{ restOfWorld: true }],
    methodDefinitionsToCreate: zone.rates.map((rate) => {
      // "At least 5000" and "at most 4999" are how a free-shipping threshold is built:
      // one option above the line, another below it. Shopify compares the order total.
      const priceConditionsToCreate = [];
      if (rate.minOrderTotal !== null && rate.minOrderTotal !== undefined) {
        priceConditionsToCreate.push({
          operator: "GREATER_THAN_OR_EQUAL_TO",
          criteria: { amount: Number(rate.minOrderTotal).toFixed(2), currencyCode },
        });
      }
      if (rate.maxOrderTotal !== null && rate.maxOrderTotal !== undefined) {
        priceConditionsToCreate.push({
          operator: "LESS_THAN_OR_EQUAL_TO",
          criteria: { amount: Number(rate.maxOrderTotal).toFixed(2), currencyCode },
        });
      }

      return {
        name: rate.name,
        active: true,
        ...(rate.transitTime ? { description: rate.transitTime } : {}),
        rateDefinition: { price: { amount: Number(rate.price).toFixed(2), currencyCode } },
        ...(priceConditionsToCreate.length ? { priceConditionsToCreate } : {}),
      };
    }),
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

export function vendorZones(shop, vendorId) {
  return db.vendorShippingZone.findMany({
    where: { shop, vendorId },
    orderBy: { createdAt: "asc" },
    include: { rates: { orderBy: { createdAt: "asc" } } },
  });
}

// Brings Shopify in line with what the vendor has set. Safe to call as often as you like:
// it replaces the vendor's zones rather than adding to them.
export async function syncVendorShipping(admin, shop, vendorId) {
  const [settings, vendor, zones] = await Promise.all([
    db.shopSettings.findUnique({ where: { shop } }),
    db.vendor.findFirst({
      where: { id: vendorId, shop },
      select: { id: true, name: true, deliveryProfileId: true },
    }),
    vendorZones(shop, vendorId),
  ]);
  if (!vendor) return { error: "Vendor not found" };
  if (!settings?.vendorShippingRates) return { skipped: "Vendors don't set their own rates in this store." };

  const currencyCode = settings.currencyCode ?? "USD";
  const { variantIds, products } = await vendorVariantIds(admin, shop, vendorId);

  // A zone with nothing in it offers no way to post anything, so it isn't sent.
  const usable = zones.filter((zone) => zone.rates.length > 0);

  // Nothing to charge: their products go back to the store's own shipping rather than
  // sitting in a profile that can't deliver.
  if (!usable.length) {
    if (vendor.deliveryProfileId && variantIds.length) {
      await admin.graphql(UPDATE_PROFILE, {
        variables: { id: vendor.deliveryProfileId, profile: { variantsToDissociate: variantIds } },
      });
    }
    return { ok: true, zones: 0, products };
  }

  const built = zonesToCreate(usable, currencyCode);

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
            locationGroupsToUpdate: [{ id: group.locationGroup.id, zonesToCreate: built }],
            ...(variantIds.length ? { variantsToAssociate: variantIds } : {}),
          },
        },
      });
      const { data: updated } = await response.json();
      const failed = updated?.deliveryProfileUpdate?.userErrors?.[0]?.message;
      if (failed) return { error: failed };
      return { ok: true, zones: built.length, products };
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
        locationGroupsToCreate: [{ locationsToAdd: locationIds, zonesToCreate: built }],
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
  return { ok: true, created: true, zones: built.length, products };
}

const amount = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= 0 ? number : NaN;
};

// Saves the lot — zones and the options inside them — replacing whatever was there.
export async function saveVendorZones(shop, vendorId, incoming) {
  const errors = {};
  const clean = [];

  (incoming ?? []).slice(0, MAX_ZONES).forEach((zone, z) => {
    const name = String(zone?.name ?? "").trim().slice(0, 60);
    const countryCodes = [
      ...new Set(
        (Array.isArray(zone?.countryCodes) ? zone.countryCodes : [])
          .map((code) => String(code).toUpperCase().slice(0, 2))
          .filter((code) => COUNTRY_NAMES[code]),
      ),
    ];

    if (!name) errors[`zones.${z}.name`] = "Give this zone a name, so you can tell them apart";

    const rates = [];
    (Array.isArray(zone?.rates) ? zone.rates : []).slice(0, MAX_RATES_PER_ZONE).forEach((rate, r) => {
      const rateName = String(rate?.name ?? "").trim().slice(0, 80);
      const price = Number(rate?.price);
      const min = amount(rate?.minOrderTotal);
      const max = amount(rate?.maxOrderTotal);

      if (!rateName) errors[`zones.${z}.rates.${r}.name`] = "Name this option — the customer sees it";
      if (!Number.isFinite(price) || price < 0) {
        errors[`zones.${z}.rates.${r}.price`] = "Use a price of zero or more";
      }
      if (Number.isNaN(min)) errors[`zones.${z}.rates.${r}.minOrderTotal`] = "Use an amount, or leave it empty";
      if (Number.isNaN(max)) errors[`zones.${z}.rates.${r}.maxOrderTotal`] = "Use an amount, or leave it empty";
      if (min !== null && max !== null && !Number.isNaN(min) && !Number.isNaN(max) && min > max) {
        errors[`zones.${z}.rates.${r}.maxOrderTotal`] = "This has to be more than the smallest order";
      }

      rates.push({
        name: rateName,
        price: Number.isFinite(price) && price >= 0 ? price.toFixed(2) : "0.00",
        transitTime: String(rate?.transitTime ?? "").trim().slice(0, 80) || null,
        minOrderTotal: min === null || Number.isNaN(min) ? null : min.toFixed(2),
        maxOrderTotal: max === null || Number.isNaN(max) ? null : max.toFixed(2),
      });
    });

    if (!rates.length) errors[`zones.${z}.rates`] = "Add a delivery option, or remove the zone";

    // Two options with the same name in one zone are indistinguishable at checkout.
    const names = rates.map((rate) => rate.name.toLowerCase());
    if (names.length && new Set(names).size !== names.length) {
      errors[`zones.${z}.rates`] = "Two options here have the same name. Give them different ones.";
    }

    clean.push({ name, countryCodes, rates });
  });

  // A country belongs to one zone only. Shopify gives it to the first and leaves the
  // other covering nowhere, which is how a rate silently stops being offered.
  const claimed = new Map();
  clean.forEach((zone, z) => {
    for (const code of zone.countryCodes) {
      if (claimed.has(code)) {
        errors[`zones.${z}.countryCodes`] =
          `${COUNTRY_NAMES[code] ?? code} is already in "${claimed.get(code)}". A country can only be in one zone.`;
      } else {
        claimed.set(code, zone.name || "another zone");
      }
    }
  });

  if (clean.filter((zone) => !zone.countryCodes.length).length > 1) {
    errors.form = "Only one zone can cover everywhere else.";
  }

  if (Object.keys(errors).length) return { errors };

  await db.$transaction([
    db.vendorShippingZone.deleteMany({ where: { shop, vendorId } }),
    ...clean.map((zone) =>
      db.vendorShippingZone.create({
        data: {
          shop,
          vendorId,
          name: zone.name,
          countryCodes: zone.countryCodes,
          rates: { create: zone.rates },
        },
      }),
    ),
  ]);

  return { saved: clean.length };
}
