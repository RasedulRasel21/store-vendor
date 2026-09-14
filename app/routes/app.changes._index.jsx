import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listChangeRequests } from "../models/change-request.server";
import {
  CHANGE_REQUEST_STATUS,
  CHANGE_REQUEST_STATUSES,
  CHANGE_REQUEST_TYPE,
  formatDate,
} from "../utils/vendor-display";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const requested = new URL(request.url).searchParams.get("status");
  const status = CHANGE_REQUEST_STATUSES.includes(requested) ? requested : "PENDING";

  const { requests, counts } = await listChangeRequests(session.shop, { status });

  return {
    status,
    counts,
    requests: requests.map((change) => ({
      id: change.id,
      type: CHANGE_REQUEST_TYPE[change.type] ?? change.type,
      vendorName: change.vendor.name,
      requestedAt: formatDate(change.createdAt),
      reviewedAt: formatDate(change.reviewedAt),
    })),
  };
};

export default function SettingChanges() {
  const { status, counts, requests } = useLoaderData();

  return (
    <s-page heading="Setting changes">
      <s-section padding="none">
        <s-stack direction="inline" gap="small" padding="base">
          {CHANGE_REQUEST_STATUSES.map((value) => (
            <s-button
              key={value}
              variant={value === status ? "primary" : "secondary"}
              href={`/app/changes?status=${value}`}
            >
              {`${CHANGE_REQUEST_STATUS[value].label} (${counts[value] ?? 0})`}
            </s-button>
          ))}
        </s-stack>

        {requests.length === 0 ? (
          <s-box padding="base">
            <s-paragraph color="subdued">
              {status === "PENDING"
                ? "No changes are waiting for approval. When a vendor asks to change their payout details in the portal, the request shows up here."
                : "No requests with this status."}
            </s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Vendor</s-table-header>
              <s-table-header listSlot="secondary">Change</s-table-header>
              <s-table-header listSlot="labeled">Requested</s-table-header>
              {status !== "PENDING" && (
                <s-table-header listSlot="labeled">Reviewed</s-table-header>
              )}
            </s-table-header-row>
            <s-table-body>
              {requests.map((change) => (
                <s-table-row key={change.id}>
                  <s-table-cell>
                    <s-link href={`/app/changes/${change.id}`}>{change.vendorName}</s-link>
                  </s-table-cell>
                  <s-table-cell>{change.type}</s-table-cell>
                  <s-table-cell>{change.requestedAt}</s-table-cell>
                  {status !== "PENDING" && <s-table-cell>{change.reviewedAt ?? "—"}</s-table-cell>}
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
