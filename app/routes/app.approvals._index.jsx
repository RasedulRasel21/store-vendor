import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  approveMany,
  BULK_APPROVE_LIMIT,
  listProductSubmissions,
} from "../models/product-submission.server";
import {
  formatDate,
  SUBMISSION_REVIEW_STATUS,
  SUBMISSION_REVIEW_STATUSES,
} from "../utils/vendor-display";

const ACTOR = "merchant";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const requested = new URL(request.url).searchParams.get("status");
  const status = SUBMISSION_REVIEW_STATUSES.includes(requested) ? requested : "PENDING";

  const { submissions, counts } = await listProductSubmissions(session.shop, { status });

  return {
    status,
    counts,
    limit: BULK_APPROVE_LIMIT,
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

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const result = await approveMany(admin, session.shop, formData.getAll("ids").map(String), ACTOR);
  return result;
};

export default function ProductApprovals() {
  const { status, counts, submissions, limit } = useLoaderData();
  const result = useActionData();
  const navigation = useNavigation();
  const approving = navigation.state === "submitting";
  // An approval can succeed and still have something to say — most often that the product
  // was created but isn't published to the Online Store.
  const warnings = (result?.approved ?? []).filter((item) => item.warning);

  return (
    <s-page heading="Product approvals">
      {result?.error && <s-banner tone="critical">{result.error}</s-banner>}

      {result?.approved?.length > 0 && (
        <s-banner tone="success" heading={`${result.approved.length} approved`}>
          {result.approved.map((item) => item.title).join(", ")}
          {result.waiting > 0 &&
            ` · ${result.waiting} more still ticked: approve up to ${limit} at a time.`}
        </s-banner>
      )}

      {warnings.length > 0 && (
        <s-banner tone="warning" heading={`${warnings.length} went through with a problem`}>
          <s-unordered-list>
            {warnings.map((item) => (
              <s-list-item key={item.title}>{`${item.title}: ${item.warning}`}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}

      {result?.failed?.length > 0 && (
        <s-banner tone="critical" heading={`${result.failed.length} couldn't be approved`}>
          <s-unordered-list>
            {result.failed.map((item) => (
              <s-list-item key={item.title}>{`${item.title}: ${item.error}`}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}

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
          <Form method="post">
            <s-table>
              <s-table-header-row>
                {status === "PENDING" && <s-table-header listSlot="leading"> </s-table-header>}
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
                    {status === "PENDING" && (
                      <s-table-cell>
                        <s-checkbox
                          name="ids"
                          value={submission.id}
                          accessibilityLabel={`Approve ${submission.title}`}
                        ></s-checkbox>
                      </s-table-cell>
                    )}
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

            {status === "PENDING" && (
              <s-box padding="base">
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="base" alignItems="center">
                    <s-button type="submit" variant="primary" loading={approving}>
                      Approve ticked
                    </s-button>
                    <s-text color="subdued">
                      {`Up to ${limit} at a time. Each one is created in Shopify exactly as it would be on its own, so this can take a few seconds.`}
                    </s-text>
                  </s-stack>
                  <s-text color="subdued">
                    Open a product first if you want to see what a vendor changed before
                    approving it.
                  </s-text>
                </s-stack>
              </s-box>
            )}
          </Form>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
