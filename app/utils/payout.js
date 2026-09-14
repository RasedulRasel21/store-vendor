export const PAYOUT_METHOD = {
  BANK: "Bank account",
  BKASH: "bKash",
  NAGAD: "Nagad",
  ROCKET: "Rocket",
};

// Label/value rows for showing payout details. Empty when none are set.
export function payoutRows(method, details) {
  if (!PAYOUT_METHOD[method] || !details || typeof details !== "object") return [];

  const rows = [
    { label: "Method", value: PAYOUT_METHOD[method] },
    { label: "Account name", value: details.accountName ?? "" },
    {
      label: method === "BANK" ? "Account number" : "Mobile number",
      value: details.accountNumber ?? "",
    },
  ];

  if (method === "BANK") {
    rows.push(
      { label: "Bank", value: details.bankName ?? "" },
      { label: "Branch", value: details.branchName ?? "" },
    );
    if (details.routingNumber) rows.push({ label: "Routing number", value: details.routingNumber });
  }

  return rows;
}
