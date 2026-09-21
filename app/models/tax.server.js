import db from "../db.server";
import { round2 } from "../utils/money";
import { decryptSecret, encryptionAvailable, encryptSecret } from "../utils/secrets";

// EU member states, whose resident sellers fall under DAC7.
export const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);

// What a tax ID is called where the vendor is, so the form asks for the right thing.
export function taxIdName(countryCode, entityType) {
  if (countryCode === "US") return entityType === "BUSINESS" ? "EIN" : "SSN or ITIN";
  if (countryCode === "BD") return entityType === "BUSINESS" ? "BIN" : "TIN";
  if (countryCode === "IN") return entityType === "BUSINESS" ? "GSTIN" : "PAN";
  if (countryCode === "GB") return entityType === "BUSINESS" ? "VAT number" : "UTR or NI number";
  if (EU_COUNTRIES.has(countryCode)) return entityType === "BUSINESS" ? "VAT number" : "Tax ID (TIN)";
  return "Tax ID";
}

const text = (value, max) => String(value ?? "").trim().slice(0, max);

// Tax details save straight away, like other vendor settings; only payout details wait for
// the merchant. The full tax ID is encrypted and kept apart from everything else.
export async function saveVendorTaxInfo(vendorId, input, actor) {
  const entityType = input.entityType === "BUSINESS" ? "BUSINESS" : "INDIVIDUAL";
  const countryCode = text(input.countryCode, 2).toUpperCase();
  const legalName = text(input.legalName, 200);
  const taxId = text(input.taxId, 40).replace(/\s/g, "").toUpperCase();
  const dateOfBirth = text(input.dateOfBirth, 10);
  const address = {
    line1: text(input.line1, 200),
    line2: text(input.line2, 200) || undefined,
    city: text(input.city, 100),
    postalCode: text(input.postalCode, 20),
    countryCode,
  };

  const errors = {};
  if (legalName.length < 2) errors.legalName = "Enter the name registered for tax";
  if (!/^[A-Z]{2}$/.test(countryCode)) errors.countryCode = "Choose the country you're registered in";
  if (!taxId) errors.taxId = `Enter your ${taxIdName(countryCode, entityType)}`;
  else if (countryCode === "US" && !/^\d{9}$/.test(taxId.replace(/-/g, ""))) {
    errors.taxId = "US tax IDs have 9 digits";
  } else if (!/^[A-Z0-9-]{4,30}$/.test(taxId)) errors.taxId = "Use letters, numbers and dashes";
  // DAC7 needs an individual's date of birth; elsewhere it's only asked, not required.
  if (entityType === "INDIVIDUAL" && EU_COUNTRIES.has(countryCode) && !dateOfBirth) {
    errors.dateOfBirth = "Required for sellers in the EU";
  }
  if (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) errors.dateOfBirth = "Use the date picker";
  if (!address.line1) errors.line1 = "Enter your registered address";
  if (!address.city) errors.city = "Enter the city";
  if (Object.keys(errors).length) return { errors };
  if (!encryptionAvailable()) {
    return { error: "Tax details can't be saved yet: the store hasn't finished setting up." };
  }

  const cleanId = taxId.replace(/-/g, "");
  await db.$transaction([
    db.vendor.update({
      where: { id: vendorId },
      data: {
        taxInfo: {
          entityType,
          legalName,
          countryCode,
          taxIdType: taxIdName(countryCode, entityType),
          taxIdLast4: cleanId.slice(-4),
          ...(dateOfBirth ? { dateOfBirth } : {}),
          address,
        },
        taxIdEncrypted: encryptSecret(cleanId),
        taxInfoUpdatedAt: new Date(),
      },
    }),
    db.vendorActivity.create({
      data: { vendorId, action: "tax.updated", actor, details: { countryCode, entityType } },
    }),
  ]);

  return { ok: true };
}

// A year of a vendor's sales, month by month and quarter by quarter, in the shop currency.
async function salesByVendor(shop, year) {
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));
  const orders = await db.vendorOrder.findMany({
    where: { shop, placedAt: { gte: start, lt: end }, status: { not: "CANCELLED" } },
    select: {
      vendorId: true,
      placedAt: true,
      subtotal: true,
      refunded: true,
      commission: true,
      refundedCommission: true,
      currencyCode: true,
    },
  });

  const byVendor = new Map();
  for (const order of orders) {
    const row = byVendor.get(order.vendorId) ?? {
      count: 0,
      gross: 0,
      months: Array(12).fill(0),
      quarters: Array(4).fill(0),
      quarterCounts: Array(4).fill(0),
      quarterFees: Array(4).fill(0),
      currencyCode: order.currencyCode,
    };
    // Gross is what the buyer paid for the items, less anything refunded.
    const amount = Number(order.subtotal) - Number(order.refunded);
    const fees = Number(order.commission) - Number(order.refundedCommission);
    const month = order.placedAt.getUTCMonth();
    const quarter = Math.floor(month / 3);

    row.count += 1;
    row.gross += amount;
    row.months[month] += amount;
    row.quarters[quarter] += amount;
    row.quarterCounts[quarter] += 1;
    row.quarterFees[quarter] += fees;
    byVendor.set(order.vendorId, row);
  }
  return byVendor;
}

function cell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

const money = (value) => round2(value).toFixed(2);

// What each vendor is still missing, so the merchant can chase it before filing.
function missing(vendor, { needBirthDate }) {
  const info = vendor.taxInfo ?? {};
  return [
    !vendor.taxIdEncrypted && "tax ID",
    !info.legalName && "legal name",
    !info.address?.line1 && "address",
    needBirthDate && info.entityType === "INDIVIDUAL" && !info.dateOfBirth && "date of birth",
  ]
    .filter(Boolean)
    .join(", ");
}

// US 1099-K preparation: one row per US vendor with gross by month, as the form asks.
// The file carries full tax IDs, because that's what filing needs.
export async function report1099K(shop, year) {
  const [settings, vendors, sales] = await Promise.all([
    db.shopSettings.findUnique({ where: { shop } }),
    db.vendor.findMany({ where: { shop }, orderBy: { name: "asc" } }),
    salesByVendor(shop, year),
  ]);
  const amountThreshold = Number(settings?.us1099kAmount ?? 20000);
  const countThreshold = settings?.us1099kTransactions ?? 200;

  const header = [
    "Payee name", "TIN", "Entity", "Address", "City", "Postal code", "Transactions", "Gross amount",
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    "Over threshold", "Missing", "Currency",
  ];
  const rows = vendors
    .filter((vendor) => (vendor.taxInfo?.countryCode ?? vendor.countryCode) === "US" && sales.has(vendor.id))
    .map((vendor) => {
      const info = vendor.taxInfo ?? {};
      const sold = sales.get(vendor.id);
      return [
        info.legalName ?? vendor.name,
        decryptSecret(vendor.taxIdEncrypted) ?? "",
        info.entityType ?? "",
        [info.address?.line1, info.address?.line2].filter(Boolean).join(", "),
        info.address?.city ?? "",
        info.address?.postalCode ?? "",
        sold.count,
        money(sold.gross),
        ...sold.months.map(money),
        sold.gross >= amountThreshold && sold.count >= countThreshold ? "Yes" : "No",
        missing(vendor, { needBirthDate: false }),
        sold.currencyCode,
      ]
        .map(cell)
        .join(",");
    });

  return [
    [cell(`Thresholds used: ${money(amountThreshold)} and ${countThreshold} transactions, set in Settings`)].join(","),
    header.map(cell).join(","),
    ...rows,
  ].join("\r\n");
}

// EU DAC7: one row per EU-resident vendor with consideration, activity counts and fees by
// quarter. Goods sellers under the de minimis (fewer than 30 sales and under €2,000) are
// exempt, and flagged rather than silently left out.
export async function reportDAC7(shop, year) {
  const [settings, vendors, sales] = await Promise.all([
    db.shopSettings.findUnique({ where: { shop } }),
    db.vendor.findMany({ where: { shop }, orderBy: { name: "asc" } }),
    salesByVendor(shop, year),
  ]);
  const minCount = settings?.dac7MinTransactions ?? 30;
  const minAmount = Number(settings?.dac7MinAmount ?? 2000);

  const header = [
    "Seller name", "Entity", "TIN", "Date of birth", "Address", "City", "Postal code", "Country",
    "Consideration Q1", "Q2", "Q3", "Q4", "Activities Q1", "Q2", "Q3", "Q4",
    "Fees Q1", "Q2", "Q3", "Q4", "Reportable", "Missing", "Currency",
  ];
  const rows = vendors
    .filter((vendor) => EU_COUNTRIES.has(vendor.taxInfo?.countryCode ?? vendor.countryCode) && sales.has(vendor.id))
    .map((vendor) => {
      const info = vendor.taxInfo ?? {};
      const sold = sales.get(vendor.id);
      const exempt = sold.count < minCount && sold.gross < minAmount;
      return [
        info.legalName ?? vendor.name,
        info.entityType ?? "",
        decryptSecret(vendor.taxIdEncrypted) ?? "",
        info.dateOfBirth ?? "",
        [info.address?.line1, info.address?.line2].filter(Boolean).join(", "),
        info.address?.city ?? "",
        info.address?.postalCode ?? "",
        info.countryCode ?? vendor.countryCode ?? "",
        ...sold.quarters.map(money),
        ...sold.quarterCounts,
        ...sold.quarterFees.map(money),
        exempt ? "No (under the de minimis)" : "Yes",
        missing(vendor, { needBirthDate: true }),
        sold.currencyCode,
      ]
        .map(cell)
        .join(",");
    });

  return [
    [cell(`Exemption used: fewer than ${minCount} sales and under ${money(minAmount)}, set in Settings. Amounts are in the shop currency; DAC7 files are reported in EUR.`)].join(","),
    header.map(cell).join(","),
    ...rows,
  ].join("\r\n");
}
