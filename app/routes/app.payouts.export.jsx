import { authenticate } from "../shopify.server";
import { listPayouts } from "../models/payout.server";
import { PAYOUT_METHOD } from "../utils/payout";

// Every payout waiting to be sent, with full details, so the merchant can make the
// transfers or upload the file to their bank. Banks all want slightly different layouts,
// so this is the common superset; the payout id goes in as the reference to match
// statements back up afterwards.
const COLUMNS = [
  "Payout reference",
  "Vendor",
  "Method",
  "Account name",
  "Account",
  "Bank",
  "Branch",
  "Routing or SWIFT",
  "Amount",
  "Currency",
  "Set aside on",
];

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const payouts = await listPayouts(session.shop, { status: ["PENDING"] });

  const rows = payouts.map((payout) => {
    const details = payout.details ?? {};
    return [
      payout.id,
      payout.vendor.name,
      PAYOUT_METHOD[payout.method] ?? payout.method ?? "",
      details.accountName,
      details.accountNumber,
      details.bankName,
      details.branchName,
      details.routingNumber,
      Number(payout.amount).toFixed(2),
      payout.currencyCode,
      payout.createdAt.toISOString().slice(0, 10),
    ]
      .map(csvCell)
      .join(",");
  });

  const csv = [COLUMNS.map(csvCell).join(","), ...rows].join("\r\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="vendor-payouts-${new Date().toISOString().slice(0, 10)}.csv"`,
      // Account numbers: never cache this anywhere.
      "Cache-Control": "no-store",
    },
  });
};
