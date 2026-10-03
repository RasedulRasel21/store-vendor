// What each plan is and what it includes.
//
// Plain data, no database: the pages read it to say what a plan unlocks, and the server
// reads it to decide what is actually allowed. The vendor portal keeps its own copy of
// the same shape (vendor/lib/plan.ts), because it can't import from here.
//
// The prices are only what the app says to a merchant. What they are actually charged is
// set in the Partner Dashboard, and the two must match exactly or the app fails review on
// rule 4.2.1.

export const FEATURES = {
  // Growth
  PAYOUT_RAILS: "payout-rails",
  COD: "cod",
  INVOICES: "invoices",
  AGREEMENT: "agreement",
  VENDOR_STAFF: "vendor-staff",
  BULK_TOOLS: "bulk-tools",
  // Scale
  TAX_REPORTING: "tax-reporting",
  PAYOUT_FX: "payout-fx",
  LABELS: "labels",
};

const GROWTH_FEATURES = [
  FEATURES.PAYOUT_RAILS,
  FEATURES.COD,
  FEATURES.INVOICES,
  FEATURES.AGREEMENT,
  FEATURES.VENDOR_STAFF,
  FEATURES.BULK_TOOLS,
];

export const PLANS = {
  STARTER: { key: "STARTER", name: "Starter", price: 19, vendorLimit: 15, features: [] },
  GROWTH: { key: "GROWTH", name: "Growth", price: 49, vendorLimit: 60, features: GROWTH_FEATURES },
  SCALE: {
    key: "SCALE",
    name: "Scale",
    price: 129,
    vendorLimit: 400,
    features: [...GROWTH_FEATURES, FEATURES.TAX_REPORTING, FEATURES.PAYOUT_FX, FEATURES.LABELS],
  },
};

export const PLAN_ORDER = ["STARTER", "GROWTH", "SCALE"];

// What a merchant is told when something is locked: the cheapest plan that includes it.
export function planThatUnlocks(feature) {
  const key = PLAN_ORDER.find((plan) => PLANS[plan].features.includes(feature));
  return key ? PLANS[key] : PLANS.SCALE;
}

// The next plan up, for "you've reached 15 vendors — Growth takes 60".
export function nextPlanUp(key) {
  const index = PLAN_ORDER.indexOf(key);
  if (index === -1) return PLANS.STARTER;
  return PLANS[PLAN_ORDER[index + 1]] ?? null;
}

// The plan handles come from the Partner Dashboard, where each plan is given one. Matched
// loosely on purpose: "growth", "growth-monthly" and "storevendor-growth" all mean the
// same thing, and a plan renamed in the dashboard shouldn't switch features off.
export function planFromHandle(handle, description) {
  const text = `${handle ?? ""} ${description ?? ""}`.toLowerCase();
  if (text.includes("scale")) return "SCALE";
  if (text.includes("growth")) return "GROWTH";
  if (text.includes("starter")) return "STARTER";
  return null;
}
