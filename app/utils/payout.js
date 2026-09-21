export const PAYOUT_METHOD = {
  BANK: "Bank account",
  BKASH: "bKash",
  NAGAD: "Nagad",
  ROCKET: "Rocket",
  UPI: "UPI",
  MPESA: "M-Pesa",
  PAYPAL: "PayPal",
  PAYONEER: "Payoneer",
  WISE: "Wise",
  OTHER: "Other",
};

// Every method keeps its main identifier in accountNumber; only what it's called differs.
const ACCOUNT_LABEL = {
  BANK: "Account number or IBAN",
  BKASH: "Mobile number",
  NAGAD: "Mobile number",
  ROCKET: "Mobile number",
  MPESA: "Mobile number",
  UPI: "UPI ID",
  PAYPAL: "Email",
  PAYONEER: "Email",
  WISE: "Email",
  OTHER: "Where to send it",
};

export function accountLabel(method) {
  return ACCOUNT_LABEL[method] ?? "Account";
}

// Enough to recognise the account without putting the whole number on screen.
export function maskAccount(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.includes("@")) {
    const [name, domain] = text.split("@");
    return `${name.slice(0, 2)}•••@${domain}`;
  }
  return text.length <= 4 ? text : `•••• ${text.slice(-4)}`;
}

// Label/value rows for showing payout details. Empty when none are set.
export function payoutRows(method, details) {
  if (!PAYOUT_METHOD[method] || !details || typeof details !== "object") return [];

  const rows = [
    { label: "Method", value: PAYOUT_METHOD[method] },
    { label: "Account name", value: details.accountName ?? "" },
    { label: accountLabel(method), value: details.accountNumber ?? "" },
  ];

  if (method === "BANK") {
    rows.push(
      { label: "Bank", value: details.bankName ?? "" },
      { label: "Branch", value: details.branchName ?? "" },
    );
    if (details.routingNumber) rows.push({ label: "Routing or SWIFT code", value: details.routingNumber });
  }
  if (details.currency) rows.push({ label: "Wants paying in", value: details.currency });

  return rows;
}
