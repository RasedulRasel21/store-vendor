// Stripe Connect transfers, from the merchant's Stripe balance to a vendor's Stripe account
// on the merchant's platform. With a Shopify store the sales land in the bank, not Stripe,
// so the merchant tops up their Stripe balance first; a transfer without funds is refused.

const API = "https://api.stripe.com/v1";

// Currencies whose amounts Stripe takes in whole units rather than cents.
const ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

function form(values, prefix = "") {
  const params = new URLSearchParams();
  const add = (key, value) => {
    if (value === undefined || value === null) return;
    if (typeof value === "object") {
      for (const [inner, innerValue] of Object.entries(value)) add(`${key}[${inner}]`, innerValue);
    } else {
      params.append(key, String(value));
    }
  };
  for (const [key, value] of Object.entries(values)) add(prefix ? `${prefix}[${key}]` : key, value);
  return params;
}

async function stripe(secretKey, path, { method = "GET", body, idempotencyKey } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: body ? form(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) return { error: data?.error?.message ?? `Stripe answered ${response.status}` };
  return { data };
}

export async function checkStripe(secretKey) {
  if (!/^sk_(test|live)_/.test(secretKey)) return { error: "Use a secret key starting with sk_test_ or sk_live_" };
  const balance = await stripe(secretKey, "/balance");
  if (balance.error) return { error: "Stripe didn't accept that key" };

  const account = await stripe(secretKey, "/account");
  const name =
    account.data?.settings?.dashboard?.display_name ?? account.data?.business_profile?.name ?? account.data?.id;
  return { account: `Stripe · ${name ?? "connected"} · ${secretKey.startsWith("sk_test_") ? "test mode" : "live"}` };
}

// An Express account for the vendor on the merchant's platform, created once and reused.
export async function createVendorAccount(secretKey, { email, countryCode, vendorId }) {
  const result = await stripe(secretKey, "/accounts", {
    method: "POST",
    body: {
      type: "express",
      email,
      ...(countryCode ? { country: countryCode } : {}),
      capabilities: { transfers: { requested: true } },
      metadata: { vendor_id: vendorId },
    },
    idempotencyKey: `vendor-account-${vendorId}`,
  });
  if (result.error) return result;
  return { accountId: result.data.id };
}

export async function onboardingLink(secretKey, { accountId, returnUrl, refreshUrl }) {
  const result = await stripe(secretKey, "/account_links", {
    method: "POST",
    body: { account: accountId, return_url: returnUrl, refresh_url: refreshUrl, type: "account_onboarding" },
  });
  if (result.error) return result;
  return { url: result.data.url };
}

export async function vendorAccountStatus(secretKey, accountId) {
  const result = await stripe(secretKey, `/accounts/${encodeURIComponent(accountId)}`);
  if (result.error) return result;
  return {
    detailsSubmitted: Boolean(result.data.details_submitted),
    transfersActive: result.data.capabilities?.transfers === "active",
  };
}

// Transfers are settled as soon as Stripe accepts them. The payout id is the idempotency
// key, so a retried send can never pay twice.
export async function sendStripe(secretKey, { payoutId, destination, amount, currency, description }) {
  const code = currency.toUpperCase();
  const minor = ZERO_DECIMAL.has(code) ? Math.round(Number(amount)) : Math.round(Number(amount) * 100);

  const result = await stripe(secretKey, "/transfers", {
    method: "POST",
    body: {
      amount: minor,
      currency: code.toLowerCase(),
      destination,
      description,
      metadata: { payout_id: payoutId },
    },
    idempotencyKey: `payout-${payoutId}`,
  });
  if (result.error) {
    return {
      error: /insufficient/i.test(result.error)
        ? "Your Stripe balance doesn't have enough in it. Top it up from your bank in the Stripe dashboard, then send again."
        : result.error,
    };
  }
  return { ref: result.data.id, status: "PAID" };
}
