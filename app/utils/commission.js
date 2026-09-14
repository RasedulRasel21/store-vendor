const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

// Validates commission form input. Returns { errors } or { values } ready for Prisma.
export function parseCommission({ percent, fixed }) {
  const errors = {};
  const percentText = String(percent ?? "").trim();
  const fixedText = String(fixed ?? "").trim() || "0";

  if (!AMOUNT_PATTERN.test(percentText)) {
    errors.percent = "Enter a percentage like 10 or 12.5";
  } else if (Number(percentText) > 100) {
    errors.percent = "Enter a percentage from 0 to 100";
  }

  if (!AMOUNT_PATTERN.test(fixedText)) {
    errors.fixed = "Enter an amount of 0 or more, with up to 2 decimal places";
  }

  if (Object.keys(errors).length) return { errors };

  return {
    values: {
      commissionPercent: Number(percentText).toFixed(2),
      commissionFixed: Number(fixedText).toFixed(2),
    },
  };
}

// The rate that applies to a vendor: their override, or the store default.
export function effectiveCommission(vendor, settings) {
  const custom = vendor.commissionPercent !== null && vendor.commissionPercent !== undefined;

  return {
    custom,
    percent: String(custom ? vendor.commissionPercent : settings.commissionPercent),
    fixed: String(custom ? (vendor.commissionFixed ?? 0) : settings.commissionFixed),
  };
}

export function formatCommission({ percent, fixed }, currencyCode) {
  const percentValue = Number(percent);
  const fixedValue = Number(fixed);
  const parts = [];

  if (percentValue > 0 || fixedValue === 0) {
    parts.push(`${Number(percentValue.toFixed(2))}%`);
  }
  if (fixedValue > 0) {
    const money = new Intl.NumberFormat("en", { style: "currency", currency: currencyCode });
    parts.push(`${money.format(fixedValue)} per item`);
  }

  return parts.join(" + ");
}
