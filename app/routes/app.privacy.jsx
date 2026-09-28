import { useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { acknowledgePrivacyRequest, listPrivacyRequests } from "../models/privacy.server";
import { formatDateTime } from "../utils/vendor-display";

// Shopify passes a customer's privacy request to every app the store uses, but the duty to
// answer the customer is the merchant's. So the app does its part — gathering what it
// holds, or deleting it — and this page is where the merchant picks the answer up.
const TYPE = {
  CUSTOMER_DATA: {
    label: "Asked what you hold",
    hint: "Download this and send it to the customer. You have 30 days from the date shown.",
  },
  CUSTOMER_REDACT: {
    label: "Asked to be forgotten",
    hint: "Already done. Their details are off the orders; the sales themselves are kept for your accounts.",
  },
  SHOP_REDACT: { label: "Store data erased", hint: "Everything this app held for the store has been deleted." },
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const requests = await listPrivacyRequests(session.shop);

  return {
    requests: requests.map((entry) => ({
      id: entry.id,
      type: entry.type,
      label: TYPE[entry.type]?.label ?? entry.type,
      hint: TYPE[entry.type]?.hint ?? "",
      customer: entry.customerEmail ?? (entry.customerId ? `Customer ${entry.customerId}` : "—"),
      summary: entry.summary ?? "",
      receivedAt: formatDateTime(entry.receivedAt),
      acknowledged: Boolean(entry.acknowledgedAt),
      downloadable: entry.type === "CUSTOMER_DATA" && entry.data !== null,
    })),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") === "acknowledge") {
    await acknowledgePrivacyRequest(session.shop, String(formData.get("id") ?? ""));
  }

  return null;
};

export default function Privacy() {
  const { requests } = useLoaderData();
  const fetcher = useFetcher();
  const [downloading, setDownloading] = useState(null);

  // Fetched inside the admin frame, where the session token is added, then handed to the
  // browser to save. Opening the URL in a new tab would have no session.
  const download = async (id) => {
    setDownloading(id);
    try {
      const response = await fetch(`/app/privacy/${id}/download`);
      if (!response.ok) throw new Error(`Download failed with ${response.status}`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `customer-data-${id}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      shopify.toast.show("The file couldn't be created. Try again.", { isError: true });
    } finally {
      setDownloading(null);
    }
  };

  const waiting = requests.filter((entry) => entry.downloadable && !entry.acknowledged);

  return (
    <s-page heading="Privacy requests">
      {waiting.length > 0 && (
        <s-banner
          heading={
            waiting.length === 1
              ? "A customer is waiting for an answer"
              : `${waiting.length} customers are waiting for an answer`
          }
          tone="warning"
        >
          Shopify gives you 30 days. Download what this app holds, send it on, then mark it
          as handed over.
        </s-banner>
      )}

      <s-section heading="What Shopify has sent you">
        {requests.length === 0 ? (
          <s-paragraph color="subdued">
            Nothing yet. When a customer asks what data your store holds, or asks to be
            forgotten, Shopify tells every app you use and it shows up here — along with what
            this app did about it.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {requests.map((entry) => (
              <s-box key={entry.id} padding="base" border="base" borderRadius="base">
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-text type="strong">{entry.label}</s-text>
                    {entry.acknowledged && <s-badge tone="success">Handed over</s-badge>}
                  </s-stack>
                  <s-text color="subdued">{`${entry.customer} · ${entry.receivedAt}`}</s-text>
                  <s-text>{entry.summary}</s-text>
                  <s-text color="subdued">{entry.hint}</s-text>

                  {entry.downloadable && (
                    <s-stack direction="inline" gap="small">
                      <s-button
                        variant="primary"
                        loading={downloading === entry.id}
                        onClick={() => download(entry.id)}
                      >
                        Download the data
                      </s-button>
                      {!entry.acknowledged && (
                        <fetcher.Form method="post">
                          <input type="hidden" name="intent" value="acknowledge" />
                          <input type="hidden" name="id" value={entry.id} />
                          <s-button type="submit">Mark as handed over</s-button>
                        </fetcher.Form>
                      )}
                    </s-stack>
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="What this app holds about customers">
        <s-paragraph>
          One copy of each order, split by seller: the buyer&apos;s name, email, phone and
          delivery address, the items in their part of the order, and any tracking the seller
          added. It is there so a seller can pack and post their own parcel without being
          given the rest of the order.
        </s-paragraph>
        <s-paragraph color="subdued">
          Sellers only ever see their own orders. When a customer asks to be forgotten, their
          details come off those orders and the sale itself is kept, because your accounts and
          what you owe each seller are built from it.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
