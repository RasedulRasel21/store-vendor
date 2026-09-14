import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  approveProductSubmission,
  descriptionToHtml,
  getProductSubmission,
  rejectProductSubmission,
  submissionOptions,
  submissionVariants,
} from "../models/product-submission.server";
import { sanitizeDescription } from "../utils/sanitize-description.server";
import { formatDate, SUBMISSION_REVIEW_STATUS } from "../utils/vendor-display";

const ACTOR = "merchant";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const submission = await getProductSubmission(session.shop, params.id);

  if (!submission) {
    throw new Response("Product submission not found", { status: 404 });
  }

  return {
    submission: {
      id: submission.id,
      title: submission.title,
      descriptionHtml: submission.descriptionHtml
        ? sanitizeDescription(submission.descriptionHtml)
        : descriptionToHtml(submission.description),
      options: submissionOptions(submission),
      variants: submissionVariants(submission),
      trackInventory: submission.trackInventory,
      seoTitle: submission.seoTitle,
      seoDescription: submission.seoDescription,
      handle: submission.handle,
      productType: submission.productType,
      tags: submission.tags,
      price: submission.price === null ? null : submission.price.toFixed(2),
      compareAtPrice:
        submission.compareAtPrice === null ? null : submission.compareAtPrice.toFixed(2),
      sku: submission.sku,
      barcode: submission.barcode,
      inventoryQuantity: submission.inventoryQuantity,
      imageUrls: submission.imageUrls,
      status: submission.status,
      reviewNote: submission.reviewNote,
      productNumericId: submission.productId?.split("/").pop() ?? null,
      submittedAt: formatDate(submission.submittedAt),
      reviewedAt: formatDate(submission.reviewedAt),
      vendor: { id: submission.vendor.id, name: submission.vendor.name },
    },
  };
};

export const action = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "approve") {
    const result = await approveProductSubmission(admin, session.shop, params.id, ACTOR);
    return { intent, error: result.error ?? null, warning: result.warning ?? null };
  }

  if (intent === "reject") {
    const result = await rejectProductSubmission(
      session.shop,
      params.id,
      String(formData.get("note") ?? ""),
      ACTOR,
    );
    return { intent, error: result.error ?? null };
  }

  return { intent, error: "Unknown action" };
};

export default function ReviewProduct() {
  const { submission } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [note, setNote] = useState("");

  const result = fetcher.state === "idle" ? fetcher.data : null;
  const approving =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "approve";
  const status = SUBMISSION_REVIEW_STATUS[submission.status];
  const isPending = submission.status === "PENDING";

  useEffect(() => {
    if (!result || result.error) return;
    if (result.intent === "approve") shopify.toast.show("Product approved and created");
    if (result.intent === "reject") shopify.toast.show("Changes requested");
  }, [result, shopify]);

  const submit = (intent, extra = {}) =>
    fetcher.submit({ intent, ...extra }, { method: "post" });

  return (
    <s-page heading={submission.title}>
      <s-link slot="breadcrumb-actions" href="/app/approvals">
        Product approvals
      </s-link>
      {isPending && (
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => submit("approve")}
        >
          Approve
        </s-button>
      )}
      {isPending && (
        <s-button
          slot="secondary-actions"
          commandFor="reject-modal"
          command="--show"
        >
          Request changes
        </s-button>
      )}

      {approving && (
        <s-banner tone="info" heading="Creating the product in Shopify…">
          This can take a few seconds while images upload.
        </s-banner>
      )}

      {result?.error && (
        <s-banner tone="critical" heading="Couldn't complete this review">
          {result.error}
        </s-banner>
      )}

      {result?.warning && (
        <s-banner tone="warning" heading="Approved with a problem">
          {result.warning}
        </s-banner>
      )}

      {submission.status === "APPROVED" && submission.productNumericId && (
        <s-banner tone="success" heading="Approved and live in Shopify">
          <s-link
            href={`shopify://admin/products/${submission.productNumericId}`}
            target="_blank"
          >
            View the product in Shopify
          </s-link>
        </s-banner>
      )}

      {submission.status === "REJECTED" && submission.reviewNote && (
        <s-banner tone="warning" heading="Changes requested">
          {submission.reviewNote}
        </s-banner>
      )}

      <s-section heading="Product details">
        <s-grid gridTemplateColumns="auto 1fr" gap="base">
          <s-text color="subdued">Status</s-text>
          <s-stack direction="inline">
            <s-badge tone={status.tone}>{status.label}</s-badge>
          </s-stack>
          <s-text color="subdued">Price</s-text>
          <s-text>{submission.price ?? "Not set"}</s-text>
          <s-text color="subdued">Compare-at price</s-text>
          <s-text>{submission.compareAtPrice ?? "Not set"}</s-text>
          <s-text color="subdued">SKU</s-text>
          <s-text>{submission.sku ?? "Not set"}</s-text>
          <s-text color="subdued">Barcode</s-text>
          <s-text>{submission.barcode ?? "Not set"}</s-text>
          <s-text color="subdued">Quantity</s-text>
          <s-text>
            {submission.inventoryQuantity === null
              ? "Not set"
              : String(submission.inventoryQuantity)}
          </s-text>
          <s-text color="subdued">Product type</s-text>
          <s-text>{submission.productType ?? "Not set"}</s-text>
          <s-text color="subdued">Tags</s-text>
          <s-text>{submission.tags.length ? submission.tags.join(", ") : "None"}</s-text>
        </s-grid>
      </s-section>

      {submission.options.length > 0 && (
        <s-section heading={`Variants (${submission.variants.length})`}>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Variant</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">
                Price
              </s-table-header>
              <s-table-header listSlot="labeled">SKU</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">
                Quantity
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {submission.variants.map((variant) => {
                const name = submission.options
                  .map((option) => variant.optionValues[option.name])
                  .join(" / ");
                return (
                  <s-table-row key={name}>
                    <s-table-cell>{name}</s-table-cell>
                    <s-table-cell>{variant.price ?? "—"}</s-table-cell>
                    <s-table-cell>{variant.sku || "—"}</s-table-cell>
                    <s-table-cell>
                      {submission.trackInventory && Number.isInteger(variant.inventoryQuantity)
                        ? String(variant.inventoryQuantity)
                        : "—"}
                    </s-table-cell>
                  </s-table-row>
                );
              })}
            </s-table-body>
          </s-table>
        </s-section>
      )}

      <s-section heading="Description">
        {submission.descriptionHtml ? (
          <div dangerouslySetInnerHTML={{ __html: submission.descriptionHtml }} />
        ) : (
          <s-paragraph color="subdued">No description.</s-paragraph>
        )}
      </s-section>

      <s-section heading="Search engine listing">
        <s-grid gridTemplateColumns="auto 1fr" gap="base">
          <s-text color="subdued">Page title</s-text>
          <s-text>{submission.seoTitle ?? submission.title}</s-text>
          <s-text color="subdued">Meta description</s-text>
          <s-text>{submission.seoDescription ?? "Not set"}</s-text>
          <s-text color="subdued">URL handle</s-text>
          <s-text>{submission.handle ?? "Created from the title"}</s-text>
        </s-grid>
      </s-section>

      <s-section heading="Images">
        {submission.imageUrls.length ? (
          <s-stack direction="inline" gap="base">
            {submission.imageUrls.map((url) => (
              <s-thumbnail key={url} src={url} alt={submission.title} size="large"></s-thumbnail>
            ))}
          </s-stack>
        ) : (
          <s-paragraph color="subdued">No images added.</s-paragraph>
        )}
      </s-section>

      <s-section slot="aside" heading="Vendor">
        <s-stack direction="block" gap="small">
          <s-link href={`/app/vendors/${submission.vendor.id}`}>
            {submission.vendor.name}
          </s-link>
          <s-text color="subdued">{`Submitted ${submission.submittedAt ?? "—"}`}</s-text>
          {submission.reviewedAt && (
            <s-text color="subdued">{`Reviewed ${submission.reviewedAt}`}</s-text>
          )}
        </s-stack>
      </s-section>

      <s-modal id="reject-modal" heading="Request changes?">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            The vendor sees your note in their portal and can update the product
            and submit it again.
          </s-paragraph>
          <s-text-area
            label="What should the vendor change?"
            rows={4}
            value={note}
            onInput={(event) => setNote(event.currentTarget.value)}
          ></s-text-area>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          commandFor="reject-modal"
          command="--hide"
          disabled={!note.trim()}
          onClick={() => submit("reject", { note })}
        >
          Send to vendor
        </s-button>
        <s-button
          slot="secondary-actions"
          commandFor="reject-modal"
          command="--hide"
        >
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
