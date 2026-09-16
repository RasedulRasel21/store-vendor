// Money helpers for the commission ledger. Amounts are strings or numbers in the shop currency.

export function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function formatMoney(amount, currencyCode) {
  if (amount === null || amount === undefined) return "—";
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currencyCode }).format(Number(amount));
  } catch {
    return `${Number(amount).toFixed(2)} ${currencyCode}`;
  }
}
