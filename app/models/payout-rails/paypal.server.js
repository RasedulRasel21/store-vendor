// PayPal Payouts, sending from the merchant's own PayPal business account to the email a
// vendor gave as their payout details. Sandbox and live use different hosts.

const HOSTS = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

// Currencies PayPal Payouts can send. BDT isn't one, so a Bangladeshi store needs currency
// conversion switched on for PayPal to work at all.
export const PAYPAL_CURRENCIES = new Set([
  "AUD", "BRL", "CAD", "CNY", "CZK", "DKK", "EUR", "HKD", "HUF", "ILS", "JPY", "MYR", "MXN",
  "TWD", "NZD", "NOK", "PHP", "PLN", "GBP", "SGD", "SEK", "CHF", "THB", "USD",
]);

async function accessToken({ mode, clientId, secret }) {
  const response = await fetch(`${HOSTS[mode]}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      // eslint-disable-next-line no-undef
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token) {
    return { error: data?.error_description ?? "PayPal didn't accept that client ID and secret" };
  }
  return { token: data.access_token };
}

export async function checkPaypal(credentials) {
  const result = await accessToken(credentials);
  if (result.error) return result;
  return { account: `PayPal · ${credentials.mode === "live" ? "live" : "sandbox"}` };
}

// PayPal refuses a batch id it has seen in the last 30 days, so using the payout's own id
// means a retried send can never pay twice.
export async function sendPaypal(credentials, { payoutId, receiver, amount, currency, note }) {
  if (!PAYPAL_CURRENCIES.has(currency)) {
    return {
      error: `PayPal can't send ${currency}. Switch on currency conversion in Settings and have the vendor choose a currency PayPal supports, like USD.`,
    };
  }
  const auth = await accessToken(credentials);
  if (auth.error) return auth;

  const response = await fetch(`${HOSTS[credentials.mode]}/v1/payments/payouts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      sender_batch_header: {
        sender_batch_id: payoutId,
        email_subject: "You have a payout",
        email_message: note,
      },
      items: [
        {
          recipient_type: "EMAIL",
          receiver,
          amount: { value: amount, currency },
          note,
          sender_item_id: payoutId,
        },
      ],
    }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    return { error: data?.details?.[0]?.issue ?? data?.message ?? `PayPal answered ${response.status}` };
  }
  return { ref: data?.batch_header?.payout_batch_id, status: data?.batch_header?.batch_status ?? "PENDING" };
}

// PayPal settles in the background. SUCCESS is paid; FAILED, RETURNED, BLOCKED, REFUNDED and
// REVERSED mean the money never arrived; UNCLAIMED waits up to 30 days for the vendor to
// open a PayPal account, then comes back.
export async function paypalStatus(credentials, ref) {
  const auth = await accessToken(credentials);
  if (auth.error) return auth;

  const response = await fetch(`${HOSTS[credentials.mode]}/v1/payments/payouts/${encodeURIComponent(ref)}`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) return { error: data?.message ?? `PayPal answered ${response.status}` };

  const item = data?.items?.[0];
  const itemStatus = item?.transaction_status ?? data?.batch_header?.batch_status ?? "PENDING";
  const outcome =
    itemStatus === "SUCCESS"
      ? "PAID"
      : ["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "DENIED"].includes(itemStatus)
        ? "FAILED"
        : "PENDING";

  return {
    outcome,
    status: itemStatus,
    reference: item?.transaction_id ?? null,
    reason: item?.errors?.message ?? item?.errors?.name ?? null,
  };
}
