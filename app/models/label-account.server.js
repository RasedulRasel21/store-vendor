import db from "../db.server";
import { decryptSecret, encryptionAvailable, encryptSecret } from "../utils/secrets";

// Labels are bought through the merchant's own carrier account, so the app never holds
// money or a carrier contract of its own. Two providers cover most countries between them.
export const LABEL_PROVIDERS = {
  shippo: { label: "Shippo", keyHint: "Starts with shippo_live_ or shippo_test_" },
  easypost: { label: "EasyPost", keyHint: "Your production or test API key" },
};

// Checks the key really works before it's saved, so a typo is caught here and not on the
// evening a vendor is trying to print a label.
async function checkKey(provider, apiKey) {
  if (provider === "shippo") {
    const response = await fetch("https://api.goshippo.com/carrier_accounts/?results=1", {
      headers: { Authorization: `ShippoToken ${apiKey}` },
    });
    if (!response.ok) return { error: "Shippo didn't accept that key" };

    const data = await response.json().catch(() => null);
    const carriers = data?.count ?? data?.results?.length ?? 0;
    return { account: `Shippo · ${carriers} ${carriers === 1 ? "carrier" : "carriers"}` };
  }

  if (provider === "easypost") {
    const response = await fetch("https://api.easypost.com/v2/user", {
      // eslint-disable-next-line no-undef
      headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` },
    });
    if (!response.ok) return { error: "EasyPost didn't accept that key" };

    const data = await response.json().catch(() => null);
    return { account: `EasyPost · ${data?.name ?? data?.email ?? "connected"}` };
  }

  return { error: "Unknown provider" };
}

export async function connectLabelAccount(shop, provider, apiKey) {
  if (!LABEL_PROVIDERS[provider]) return { error: "Choose a provider" };
  if (!apiKey?.trim()) return { error: "Paste the API key" };
  if (!encryptionAvailable()) {
    return { error: "This store can't hold carrier keys yet: ENCRYPTION_KEY isn't set on the server." };
  }

  let result;
  try {
    result = await checkKey(provider, apiKey.trim());
  } catch (error) {
    console.error("Label provider check failed", error);
    return { error: "Couldn't reach the provider. Try again." };
  }
  if (result.error) return result;

  await db.shopSettings.upsert({
    where: { shop },
    update: { labelProvider: provider, labelApiKey: encryptSecret(apiKey.trim()), labelAccount: result.account },
    create: { shop, labelProvider: provider, labelApiKey: encryptSecret(apiKey.trim()), labelAccount: result.account },
  });

  return { account: result.account };
}

export async function disconnectLabelAccount(shop) {
  await db.shopSettings.upsert({
    where: { shop },
    update: { labelProvider: null, labelApiKey: null, labelAccount: null },
    create: { shop },
  });
  return { ok: true };
}

// For the code that buys labels: the key in the clear, never sent anywhere but the carrier.
export async function labelCredentials(shop) {
  const settings = await db.shopSettings.findUnique({
    where: { shop },
    select: { labelProvider: true, labelApiKey: true },
  });
  const apiKey = decryptSecret(settings?.labelApiKey);
  if (!settings?.labelProvider || !apiKey) return null;

  return { provider: settings.labelProvider, apiKey };
}
