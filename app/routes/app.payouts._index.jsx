import { useEffect, useState } from "react";
import { Form, useActionData, useLoaderData, useNavigation, useSubmit } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  acceptPayoutRequest,
  cancelPayout,
  createPayout,
  failPayout,
  listPayouts,
  markPayoutPaid,
  payEveryoneDue,
  payoutOverview,
} from "../models/payout.server";
import { formatMoney } from "../utils/money";
import { accountLabel, maskAccount, PAYOUT_METHOD } from "../utils/payout";
import { formatDate } from "../utils/vendor-display";

const ACTOR = "merchant";

const TABS = {
  requested: { label: "Requested", statuses: ["REQUESTED"] },
  "to-send": { label: "To send", statuses: ["PENDING"] },
  sent: { label: "Sent", statuses: ["PAID"] },
  closed: { label: "Called off or bounced", statuses: ["FAILED", "CANCELLED"] },
};

const STATUS = {
  REQUESTED: { label: "Requested", tone: "info" },
  PENDING: { label: "To send", tone: "warning" },
  PAID: { label: "Sent", tone: "success" },
  FAILED: { label: "Bounced", tone: "critical" },
  CANCELLED: { label: "Called off", tone: "neutral" },
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const params = new URL(request.url).searchParams;

  const { settings, rows, counts } = await payoutOverview(session.shop);
  const requested = params.get("tab");
  // Requests are waiting on the merchant, so they're what opens first when there are any.
  const tab = TABS[requested] ? requested : counts.REQUESTED?.count ? "requested" : "to-send";
  const payouts = await listPayouts(session.shop, { status: TABS[tab].statuses });
  const currency = settings.currencyCode ?? "USD";
  const total = (key) => rows.reduce((sum, row) => sum + row[key], 0);

  return {
    tab,
    currency,
    holdDays: settings.payoutHoldDays,
    counts: Object.fromEntries(
      Object.entries(TABS).map(([key, value]) => [
        key,
        value.statuses.reduce((sum, status) => sum + (counts[status]?.count ?? 0), 0),
      ]),
    ),
    totals: {
      available: formatMoney(total("available"), currency),
      inFlight: formatMoney(total("inFlight"), currency),
      pending: formatMoney(total("pending"), currency),
      paid: formatMoney(total("paid"), currency),
    },
    vendors: rows.map((row) => ({
      id: row.id,
      name: row.name,
      method: row.payoutMethod ? PAYOUT_METHOD[row.payoutMethod] : null,
      pending: formatMoney(row.pending, currency),
      available: formatMoney(row.available, currency),
      canPay: Boolean(row.payoutMethod) && row.available > 0,
      owesUs: row.available < 0,
    })),
    payouts: payouts.map((payout) => ({
      id: payout.id,
      vendorId: payout.vendor.id,
      vendorName: payout.vendor.name,
      amount: formatMoney(payout.amount, payout.currencyCode),
      status: payout.status,
      method: payout.method ? PAYOUT_METHOD[payout.method] : "—",
      account: payout.details?.accountNumber
        ? `${accountLabel(payout.method)} ${maskAccount(payout.details.accountNumber)}`
        : null,
      reference: payout.reference,
      note: payout.note,
      requested: Boolean(payout.requestedAt),
      createdAt: formatDate(payout.createdAt),
      paidAt: formatDate(payout.paidAt),
    })),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const payoutId = String(formData.get("payoutId") ?? "");
  const note = String(formData.get("note") ?? "");

  let result;
  if (intent === "pay") {
    result = await createPayout(session.shop, String(formData.get("vendorId") ?? ""), { actor: ACTOR });
  } else if (intent === "payAll") {
    const outcome = await payEveryoneDue(session.shop, ACTOR);
    return { intent, created: outcome.created.length, skipped: outcome.skipped, missingDetails: outcome.missingDetails };
  } else if (intent === "sent") {
    result = await markPayoutPaid(session.shop, payoutId, {
      reference: String(formData.get("reference") ?? ""),
      actor: ACTOR,
    });
  } else if (intent === "callOff") {
    result = await cancelPayout(session.shop, payoutId, { note, actor: ACTOR });
  } else if (intent === "bounced") {
    result = await failPayout(session.shop, payoutId, { note, actor: ACTOR });
  } else if (intent === "accept") {
    result = await acceptPayoutRequest(session.shop, payoutId, ACTOR);
  } else if (intent === "decline") {
    result = await cancelPayout(session.shop, payoutId, { note: note || "Not paid out this time", actor: ACTOR });
  } else {
    return { intent, error: "Unknown action" };
  }

  return { intent, error: result?.error ?? null, ok: !result?.error };
};

const DONE = {
  pay: "Set aside. Send it, then mark it sent.",
  sent: "Marked sent",
  callOff: "Called off. The money is owed again.",
  bounced: "Marked bounced. The money is owed again.",
  accept: "Accepted. Send it, then mark it sent.",
  decline: "Request turned down",
};

export default function Payouts() {
  const { tab, counts, totals, vendors, payouts, holdDays } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();
  const [exporting, setExporting] = useState(null);
  const busy = (intent, id) =>
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === intent &&
    (!id || navigation.formData?.get("payoutId") === id || navigation.formData?.get("vendorId") === id);

  useEffect(() => {
    if (!actionData || actionData.error) return;
    if (actionData.intent === "payAll") {
      shopify.toast.show(
        actionData.created
          ? `${actionData.created} ${actionData.created === 1 ? "payout" : "payouts"} ready to send`
          : "Nobody is due a payout right now",
      );
    } else if (DONE[actionData.intent]) {
      shopify.toast.show(DONE[actionData.intent]);
    }
  }, [actionData, shopify]);

  // Fetched inside the admin frame, where the session token is added, then handed to the
  // browser to save. Opening the URL in a new tab would have no session.
  const download = async (path, filename) => {
    setExporting(path);
    try {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`Export failed with ${response.status}`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      shopify.toast.show("The file couldn't be created. Try again.", { isError: true });
    } finally {
      setExporting(null);
    }
  };
  const thisYear = new Date().getFullYear();

  return (
    <s-page heading="Payouts">
      <s-button
        slot="primary-action"
        variant="primary"
        loading={busy("payAll")}
        onClick={() => submit({ intent: "payAll" }, { method: "post" })}
      >
        Pay everyone due
      </s-button>
      <s-button
        slot="secondary-actions"
        loading={exporting === "/app/payouts/export"}
        onClick={() =>
          download("/app/payouts/export", `vendor-payouts-${new Date().toISOString().slice(0, 10)}.csv`)
        }
      >
        Export bank file
      </s-button>
      {[thisYear, thisYear - 1].map((year) => (
        <s-button
          key={year}
          slot="secondary-actions"
          loading={exporting === `/app/payouts/report?year=${year}`}
          onClick={() => download(`/app/payouts/report?year=${year}`, `vendor-summary-${year}.csv`)}
        >
          {`${year} summary`}
        </s-button>
      ))}

      {actionData?.error && <s-banner tone="critical">{actionData.error}</s-banner>}
      {actionData?.intent === "payAll" && (actionData.skipped?.length > 0 || actionData.missingDetails > 0) && (
        <s-banner tone="warning" heading="Some vendors weren't paid">
          {[
            actionData.missingDetails
              ? `${actionData.missingDetails} haven't added payout details yet.`
              : null,
            ...actionData.skipped.map((row) => `${row.vendor}: ${row.reason}`),
          ]
            .filter(Boolean)
            .join(" ")}
        </s-banner>
      )}

      <s-section>
        <s-paragraph color="subdued">
          {`StoreVendor never moves money. Send each payout from your own bank or wallet, then mark it sent here. A vendor's share becomes available ${holdDays} ${holdDays === 1 ? "day" : "days"} after the order is both paid and shipped.`}
        </s-paragraph>
        <s-grid gridTemplateColumns="repeat(4, minmax(0, 1fr))" gap="base">
          <s-stack direction="block">
            <s-text color="subdued">Available to pay</s-text>
            <s-heading>{totals.available}</s-heading>
          </s-stack>
          <s-stack direction="block">
            <s-text color="subdued">Waiting to be sent</s-text>
            <s-heading>{totals.inFlight}</s-heading>
          </s-stack>
          <s-stack direction="block">
            <s-text color="subdued">Not yet available</s-text>
            <s-heading>{totals.pending}</s-heading>
          </s-stack>
          <s-stack direction="block">
            <s-text color="subdued">Paid so far</s-text>
            <s-heading>{totals.paid}</s-heading>
          </s-stack>
        </s-grid>
      </s-section>

      <s-section heading="What each vendor is owed" padding="none">
        {vendors.length === 0 ? (
          <s-box padding="base">
            <s-paragraph color="subdued">No vendor has earned anything yet.</s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Vendor</s-table-header>
              <s-table-header listSlot="labeled">Paid by</s-table-header>
              <s-table-header listSlot="labeled" format="currency">
                Not yet available
              </s-table-header>
              <s-table-header listSlot="labeled" format="currency">
                Available
              </s-table-header>
              <s-table-header listSlot="labeled">Action</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {vendors.map((vendor) => (
                <s-table-row key={vendor.id}>
                  <s-table-cell>
                    <s-link href={`/app/vendors/${vendor.id}`}>{vendor.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>{vendor.method ?? "No payout details"}</s-table-cell>
                  <s-table-cell>{vendor.pending}</s-table-cell>
                  <s-table-cell>
                    {vendor.owesUs ? (
                      <s-badge tone="critical">{`${vendor.available} owed back`}</s-badge>
                    ) : (
                      vendor.available
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {vendor.canPay ? (
                      <Form method="post">
                        <input type="hidden" name="intent" value="pay" />
                        <input type="hidden" name="vendorId" value={vendor.id} />
                        <s-button type="submit" loading={busy("pay", vendor.id)}>
                          Pay
                        </s-button>
                      </Form>
                    ) : (
                      <s-text color="subdued">—</s-text>
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Payouts" padding="none">
        <s-box padding="base">
          <s-stack direction="inline" gap="small">
            {Object.entries(TABS).map(([key, value]) => (
              <s-button key={key} href={`/app/payouts?tab=${key}`} variant={key === tab ? "primary" : "secondary"}>
                {`${value.label} (${counts[key] ?? 0})`}
              </s-button>
            ))}
          </s-stack>
        </s-box>

        {payouts.length === 0 ? (
          <s-box padding="base">
            <s-paragraph color="subdued">Nothing here.</s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Vendor</s-table-header>
              <s-table-header listSlot="labeled" format="currency">
                Amount
              </s-table-header>
              <s-table-header listSlot="labeled">Send to</s-table-header>
              <s-table-header listSlot="labeled">Date</s-table-header>
              <s-table-header listSlot="labeled">Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {payouts.map((payout) => (
                <s-table-row key={payout.id}>
                  <s-table-cell>
                    <s-stack direction="block">
                      <s-link href={`/app/vendors/${payout.vendorId}`}>{payout.vendorName}</s-link>
                      {payout.requested && <s-text color="subdued">Asked for by the vendor</s-text>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{payout.amount}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="block">
                      <s-text>{payout.method}</s-text>
                      {payout.account && <s-text color="subdued">{payout.account}</s-text>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{payout.paidAt ?? payout.createdAt}</s-table-cell>
                  <s-table-cell>{payoutActions(payout, busy)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

// What can be done next depends on where the payout is in its life.
function payoutActions(payout, busy) {
  const status = STATUS[payout.status];

  if (payout.status === "REQUESTED") {
    return (
      <s-stack direction="inline" gap="small">
        <Form method="post">
          <input type="hidden" name="intent" value="accept" />
          <input type="hidden" name="payoutId" value={payout.id} />
          <s-button type="submit" variant="primary" loading={busy("accept", payout.id)}>
            Accept
          </s-button>
        </Form>
        <Form method="post">
          <input type="hidden" name="intent" value="decline" />
          <input type="hidden" name="payoutId" value={payout.id} />
          <s-button type="submit" loading={busy("decline", payout.id)}>
            Decline
          </s-button>
        </Form>
      </s-stack>
    );
  }

  if (payout.status === "PENDING") {
    return (
      <s-stack direction="block" gap="small">
        <Form method="post">
          <input type="hidden" name="intent" value="sent" />
          <input type="hidden" name="payoutId" value={payout.id} />
          <s-grid gridTemplateColumns="minmax(8rem, 1fr) auto" gap="small" alignItems="end">
            <s-text-field label="Bank or wallet reference" name="reference" placeholder="TRX…"></s-text-field>
            <s-button type="submit" variant="primary" loading={busy("sent", payout.id)}>
              Mark sent
            </s-button>
          </s-grid>
        </Form>
        <Form method="post">
          <input type="hidden" name="intent" value="callOff" />
          <input type="hidden" name="payoutId" value={payout.id} />
          <s-button type="submit" variant="tertiary" loading={busy("callOff", payout.id)}>
            Call off
          </s-button>
        </Form>
      </s-stack>
    );
  }

  if (payout.status === "PAID") {
    return (
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small" alignItems="center">
          <s-badge tone={status.tone}>{status.label}</s-badge>
          {payout.reference && <s-text color="subdued">{payout.reference}</s-text>}
        </s-stack>
        <Form method="post">
          <input type="hidden" name="intent" value="bounced" />
          <input type="hidden" name="payoutId" value={payout.id} />
          <input type="hidden" name="note" value="The transfer bounced" />
          <s-button type="submit" variant="tertiary" tone="critical" loading={busy("bounced", payout.id)}>
            It bounced
          </s-button>
        </Form>
      </s-stack>
    );
  }

  return (
    <s-stack direction="block">
      <s-badge tone={status.tone}>{status.label}</s-badge>
      {payout.note && <s-text color="subdued">{payout.note}</s-text>}
    </s-stack>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
