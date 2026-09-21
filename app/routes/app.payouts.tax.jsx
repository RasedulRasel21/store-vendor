import { authenticate } from "../shopify.server";
import { report1099K, reportDAC7 } from "../models/tax.server";

// Tax filing files for the merchant, who files them as the marketplace operator. They
// carry full tax IDs because filing needs them, so they're never cached.
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const params = new URL(request.url).searchParams;
  const type = params.get("type");
  const year = Number(params.get("year"));

  if (!["1099k", "dac7"].includes(type) || !Number.isInteger(year) || year < 2000 || year > 2100) {
    return new Response("Choose a report and a year", { status: 400 });
  }

  const csv = type === "1099k" ? await report1099K(session.shop, year) : await reportDAC7(session.shop, year);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${type}-${year}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
