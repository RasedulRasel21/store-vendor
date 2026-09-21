import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getInvoice, periodLabel } from "../models/invoice.server";
import { formatMoney } from "../utils/money";
import { formatDate } from "../utils/vendor-display";

// An issued invoice, exactly as it was issued: every figure and both addresses come from
// the invoice row, not from today's settings.
export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const invoice = await getInvoice(session.shop, params.id);
  if (!invoice) throw new Response("Invoice not found", { status: 404 });

  const money = (value) => formatMoney(value, invoice.currencyCode);
  return {
    invoice: {
      id: invoice.id,
      vendorId: invoice.vendorId,
      number: invoice.number,
      credit: Number(invoice.total) < 0,
      period: periodLabel(invoice.periodStart),
      issuedAt: formatDate(invoice.issuedAt),
      seller: invoice.seller,
      buyer: invoice.buyer,
      lines: (invoice.lines ?? []).map((line) => ({ ...line, amount: money(line.amount) })),
      net: money(invoice.net),
      taxLine: `${invoice.taxLabel} at ${Number(invoice.taxRate)}%`,
      taxAmount: money(invoice.taxAmount),
      total: money(invoice.total),
    },
  };
};

export default function Invoice() {
  const { invoice } = useLoaderData();

  return (
    <s-page heading={`${invoice.credit ? "Credit note" : "Invoice"} ${invoice.number}`}>
      <s-link slot="breadcrumb-actions" href={`/app/vendors/${invoice.vendorId}`}>
        Vendor
      </s-link>
      <s-button slot="primary-action" onClick={() => window.print()}>
        Print
      </s-button>

      <s-section>
        <s-stack direction="block" gap="large">
          <s-grid gridTemplateColumns="1fr 1fr" gap="large">
            <s-stack direction="block" gap="small-200">
              <s-text color="subdued">From</s-text>
              <s-text type="strong">{invoice.seller.name}</s-text>
              <s-text>{invoice.seller.address}</s-text>
              <s-text>{`Tax number: ${invoice.seller.taxId}`}</s-text>
            </s-stack>
            <s-stack direction="block" gap="small-200">
              <s-text color="subdued">To</s-text>
              <s-text type="strong">{invoice.buyer.name}</s-text>
              {invoice.buyer.address && <s-text>{invoice.buyer.address}</s-text>}
              <s-text>{invoice.buyer.email}</s-text>
              {invoice.buyer.taxId && <s-text>{`Tax number: ${invoice.buyer.taxId}`}</s-text>}
            </s-stack>
          </s-grid>

          <s-grid gridTemplateColumns="auto 1fr" gap="small">
            <s-text color="subdued">Number</s-text>
            <s-text>{invoice.number}</s-text>
            <s-text color="subdued">Issued</s-text>
            <s-text>{invoice.issuedAt}</s-text>
            <s-text color="subdued">For</s-text>
            <s-text>{`Marketplace commission, ${invoice.period}`}</s-text>
          </s-grid>

          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Description</s-table-header>
              <s-table-header listSlot="labeled">Order date</s-table-header>
              <s-table-header listSlot="labeled" format="currency">
                Amount
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {invoice.lines.map((line) => (
                <s-table-row key={`${line.vendorOrderId}-${line.description}`}>
                  <s-table-cell>{line.description}</s-table-cell>
                  <s-table-cell>{line.date}</s-table-cell>
                  <s-table-cell>{line.amount}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>

          <s-stack direction="block" gap="small">
            <s-stack direction="inline" justifyContent="space-between">
              <s-text color="subdued">Net</s-text>
              <s-text>{invoice.net}</s-text>
            </s-stack>
            <s-stack direction="inline" justifyContent="space-between">
              <s-text color="subdued">{invoice.taxLine}</s-text>
              <s-text>{invoice.taxAmount}</s-text>
            </s-stack>
            <s-divider></s-divider>
            <s-stack direction="inline" justifyContent="space-between">
              <s-text type="strong">Total</s-text>
              <s-text type="strong">{invoice.total}</s-text>
            </s-stack>
          </s-stack>

          <s-paragraph color="subdued">
            Commission is deducted from the vendor&apos;s earnings before payout, so this invoice has
            already been settled.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
