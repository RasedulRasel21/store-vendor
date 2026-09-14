import db from "../db.server";
import { getShopSettings } from "./settings.server";

// The cod-rules Function (extensions/cod-rules) hides cash on delivery at checkout.
// The app turns it on for each shop and keeps every vendor's COD settings in its config.
const FUNCTION_HANDLE = "cod-rules";
const CONFIG_NAMESPACE = "$app:cod-rules";
const CONFIG_KEY = "function-configuration";

const CREATE_COD_RULES = `#graphql
  mutation CreateCodRules($input: PaymentCustomizationInput!) {
    paymentCustomizationCreate(paymentCustomization: $input) {
      paymentCustomization {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }`;

const SET_COD_RULES_CONFIG = `#graphql
  mutation SetCodRulesConfig($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors {
        field
        message
      }
    }
  }`;

// Only vendors with a restriction are listed, which keeps the config small.
export async function codRulesConfig(shop) {
  const vendors = await db.vendor.findMany({
    where: { shop, OR: [{ codEnabled: false }, { codMaxOrderValue: { not: null } }] },
    select: { id: true, codEnabled: true, codMaxOrderValue: true },
  });

  return {
    vendors: Object.fromEntries(
      vendors.map((vendor) => [
        vendor.id,
        vendor.codEnabled
          ? { codEnabled: true, maxOrderValue: Number(vendor.codMaxOrderValue) }
          : { codEnabled: false },
      ]),
    ),
  };
}

function configMetafield(value) {
  return { namespace: CONFIG_NAMESPACE, key: CONFIG_KEY, type: "json", value };
}

// Creates the payment customization if needed, then writes the current vendor COD rules.
export async function syncCodRules(admin, shop) {
  const [settings, config] = await Promise.all([getShopSettings(shop), codRulesConfig(shop)]);
  const value = JSON.stringify(config);

  if (settings.codRulesCustomizationId) {
    const response = await admin.graphql(SET_COD_RULES_CONFIG, {
      variables: {
        metafields: [{ ownerId: settings.codRulesCustomizationId, ...configMetafield(value) }],
      },
    });
    const { data } = await response.json();
    if (data?.metafieldsSet && !data.metafieldsSet.userErrors.length) return;
    // The customization was probably deleted in Shopify admin, so create it again.
  }

  const response = await admin.graphql(CREATE_COD_RULES, {
    variables: {
      input: {
        title: "StoreVendor: vendor cash on delivery rules",
        enabled: true,
        functionHandle: FUNCTION_HANDLE,
        metafields: [configMetafield(value)],
      },
    },
  });
  const { data } = await response.json();
  const customizationId = data?.paymentCustomizationCreate?.paymentCustomization?.id;
  if (!customizationId) {
    const message = data?.paymentCustomizationCreate?.userErrors?.[0]?.message;
    throw new Error(`Couldn't turn on vendor COD rules: ${message ?? "unknown error"}`);
  }

  await db.shopSettings.update({
    where: { shop },
    data: { codRulesCustomizationId: customizationId },
  });
}

// Turns the COD rules on the first time the app loads for a shop.
export async function ensureCodRules(admin, shop) {
  const settings = await getShopSettings(shop);
  if (settings.codRulesCustomizationId) return;
  await syncCodRules(admin, shop);
}
