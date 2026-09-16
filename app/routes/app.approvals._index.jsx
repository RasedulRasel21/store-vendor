import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listProductSubmissions } from "../models/product-submission.server";
import {
  formatDate,
  SUBMISSION_REVIEW_STATUS,
  SUBMISSION_REVIEW_STATUSES,
} from "../utils/vendor-display";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const requested = new URL(request.url).searchParams.get("status");
  const status = SUBMISSION_REVIEW_STATUSES.includes(requested) ? requested : "PENDING";

  const { submissions, counts } = await listProductSubmissions(session.shop, { status });

  return {
    status,
    counts,
    submissions: submissions.map((submission) => ({
      id: submission.id,
      title: submission.title,
      isEdit: Boolean(submission.pendingSubmittedAt),
      vendorName: submission.vendor.name,
      price: submission.price === null ? null : submission.price.toFixed(2),
      submittedAt: formatDate(submission.submittedAt),
    })),
  };
};

export default function ProductApprovals() {
  const { status, counts, submissions } = useLoaderData();

  return (
    <s-page heading="Product approvals">
      <s-section padding="none">
        <s-stack direction="inline" gap="small" padding="base">
          {SUBMISSION_REVIEW_STATUSES.map((value) => (
            <s-button
              key={value}
              variant={value === status ? "primary" : "secondary"}
              href={`/app/approvals?status=${value}`}
            >
              {`${SUBMISSION_REVIEW_STATUS[value].label} (${counts[value] ?? 0})`}
            </s-button>
          ))}
        </s-stack>

        {submissions.length === 0 ? (
          <s-box padding="base">
            <s-paragraph color="subdued">
              {status === "PENDING"
                ? "No products are waiting for approval. Products vendors submit from their portal show up here."
                : "No products with this status."}
            </s-paragraph>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header listSlot="secondary">Vendor</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">
                Price
              </s-table-header>
              <s-table-header listSlot="labeled">Submitted</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {submissions.map((submission) => (
                <s-table-row key={submission.id}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-link href={`/app/approvals/${submission.id}`}>
                        {submission.title}
                      </s-link>
                      {submission.isEdit && <s-badge tone="info">Edit</s-badge>}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{submission.vendorName}</s-table-cell>
                  <s-table-cell>{submission.price ?? "—"}</s-table-cell>
                  <s-table-cell>{submission.submittedAt ?? "—"}</s-table-cell>
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
