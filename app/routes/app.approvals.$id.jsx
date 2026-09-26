import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  approveProductEdit,
  approveProductSubmission,
  descriptionToHtml,
  getProductSubmission,
  rejectProductEdit,
  rejectProductSubmission,
  reviewedProduct,
  submissionOptions,
  submissionVariants,
} from "../models/product-submission.server";
import { productDiff } from "../models/product-diff.server";
import { getShopCollections } from "../models/collection.server";
import { getShopSettings } from "../models/settings.server";
import { sanitizeDescription } from "../utils/sanitize-description.server";
import { formatDate, SUBMISSION_REVIEW_STATUS } from "../utils/vendor-display";

const ACTOR = "merchant";

const WEIGHT_UNIT_LABELS = { KILOGRAMS: "kg", GRAMS: "g", POUNDS: "lb", OUNCES: "oz" };

function formatMoney(amount, currencyCode) {
  if (!amount) return "—";
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currencyCode }).format(
      Number(amount),
    );
  } catch {
    return `${amount} ${currencyCode}`;
  }
}

function variantShipping(variant) {
  if (!variant.requiresShipping) return "Not a physical product";
  const parts = [
    variant.weight ? `${variant.weight} ${WEIGHT_UNIT_LABELS[variant.weightUnit] ?? ""}`.trim() : null,
    variant.countryOfOrigin ? `Origin ${variant.countryOfOrigin}` : null,
    variant.hsCode ? `HS ${variant.hsCode}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const [submission, settings] = await Promise.all([
    getProductSubmission(session.shop, params.id),
    getShopSettings(session.shop),
  ]);

  if (!submission) {
    throw new Response("Product submission not found", { status: 404 });
  }

  // A live product with an edit waiting is reviewed on its proposed values.
  const changes = reviewedProduct(submission);
  const isEdit = Boolean(submission.pendingSubmittedAt);
  const collections = await getShopCollections(session.shop, changes.collectionIds ?? []);
  // For an edit, what's different rather than the whole product again.
  const diff = await productDiff(submission);

  return {
    currencyCode: settings.currencyCode ?? "USD",
    collections: collections.map((collection) => collection.title),
    diff,
    submission: {
      id: submission.id,
      isEdit,
      liveTitle: submission.title,
      title: changes.title,
      descriptionHtml: changes.descriptionHtml
        ? sanitizeDescription(changes.descriptionHtml)
        : descriptionToHtml(changes.description),
      options: submissionOptions(changes),
      variants: submissionVariants(changes),
      seoTitle: changes.seoTitle,
      seoDescription: changes.seoDescription,
      handle: changes.handle,
      productType: changes.productType,
      tags: changes.tags,
      imageUrls: changes.imageUrls,
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

  // Editing a live product is reviewed the same way, but applies to the existing product.
  const isEdit = formData.get("isEdit") === "true";

  if (intent === "approve") {
    const result = isEdit
      ? await approveProductEdit(admin, session.shop, params.id, ACTOR)
      : await approveProductSubmission(admin, session.shop, params.id, ACTOR);
    return { intent, error: result.error ?? null, warning: result.warning ?? null };
  }

  if (intent === "reject") {
    const note = String(formData.get("note") ?? "");
    const result = isEdit
      ? await rejectProductEdit(session.shop, params.id, note, ACTOR)
      : await rejectProductSubmission(session.shop, params.id, note, ACTOR);
    return { intent, error: result.error ?? null };
  }

  return { intent, error: "Unknown action" };
};

export default function ReviewProduct() {
  const { submission, currencyCode, collections, diff } = useLoaderData();
  // Worth shouting about: a price that moved a fifth or more.
  const bigPriceMove = Boolean(diff?.biggestPriceMove) && Math.abs(diff.biggestPriceMove) >= 20;
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [note, setNote] = useState("");

  const result = fetcher.state === "idle" ? fetcher.data : null;
  const approving =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "approve";
  const status = SUBMISSION_REVIEW_STATUS[submission.status];
  const isPending = submission.status === "PENDING" || submission.isEdit;

  useEffect(() => {
    if (!result || result.error) return;
    if (result.intent === "approve") shopify.toast.show("Product approved and created");
    if (result.intent === "reject") shopify.toast.show("Changes requested");
  }, [result, shopify]);

  const submit = (intent, extra = {}) =>
    fetcher.submit({ intent, isEdit: String(submission.isEdit), ...extra }, { method: "post" });

  return (
    <s-page heading={submission.title}>
      <s-link slot="breadcrumb-actions" href="/app/approvals">
        Product approvals
      </s-link>
      {isPending && (
        <s-button
          slot="primary-action"
          variant="primary"
          loading={approving}
          onClick={() => submit("approve")}
        >
          {submission.isEdit ? "Approve changes" : "Approve"}
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

      {submission.isEdit && (
        <s-banner
          tone={bigPriceMove ? "warning" : "info"}
          heading={
            bigPriceMove
              ? `A price changed by ${Math.abs(diff.biggestPriceMove)}%`
              : "Changes to a product that's live"
          }
        >
          {`The vendor edited "${submission.liveTitle}". The live product stays as it is until you approve.`}
        </s-banner>
      )}

      {submission.isEdit && (
        <s-section heading="What changed">
          {!diff || diff.changes.length === 0 ? (
            <s-paragraph color="subdued">
              Nothing we can see. They may have resubmitted without changing anything.
            </s-paragraph>
          ) : (
            <s-stack direction="block" gap="base">
              {diff.changes.map((change) => (
                <s-stack key={change.label} direction="block" gap="small">
                  <s-text type="strong">{change.label}</s-text>

                  {change.kind === "text" && (
                    <s-grid gridTemplateColumns="auto minmax(0,1fr)" gap="small">
                      <s-text color="subdued">Was</s-text>
                      <s-text>{change.before || "—"}</s-text>
                      <s-text color="subdued">Now</s-text>
                      <s-text>{change.after || "—"}</s-text>
                    </s-grid>
                  )}

                  {change.kind === "list" && (
                    <s-stack direction="block" gap="small">
                      {change.added.length > 0 && (
                        <s-stack direction="inline" gap="small" alignItems="center">
                          <s-badge tone="success">Added</s-badge>
                          <s-text>{change.added.join(", ")}</s-text>
                        </s-stack>
                      )}
                      {change.removed.length > 0 && (
                        <s-stack direction="inline" gap="small" alignItems="center">
                          <s-badge tone="critical">Removed</s-badge>
                          <s-text>{change.removed.join(", ")}</s-text>
                        </s-stack>
                      )}
                    </s-stack>
                  )}

                  {change.kind === "images" && (
                    <s-stack direction="block" gap="small">
                      {change.added.length > 0 && (
                        <s-stack direction="inline" gap="small" alignItems="center">
                          <s-badge tone="success">{`${change.added.length} added`}</s-badge>
                          {change.added.slice(0, 6).map((url) => (
                            <s-thumbnail key={url} src={url} alt="" size="small"></s-thumbnail>
                          ))}
                        </s-stack>
                      )}
                      {change.removed.length > 0 && (
                        <s-stack direction="inline" gap="small" alignItems="center">
                          <s-badge tone="critical">{`${change.removed.length} removed`}</s-badge>
                          {change.removed.slice(0, 6).map((url) => (
                            <s-thumbnail key={url} src={url} alt="" size="small"></s-thumbnail>
                          ))}
                        </s-stack>
                      )}
                      {change.reordered && <s-text color="subdued">Put in a different order</s-text>}
                    </s-stack>
                  )}

                  {change.kind === "variants" && (
                    <s-stack direction="block" gap="small">
                      {change.rows.map((row) => (
                        <s-stack key={row.name} direction="block" gap="small">
                          <s-stack direction="inline" gap="small" alignItems="center">
                            {row.kind === "added" && <s-badge tone="success">New</s-badge>}
                            {row.kind === "removed" && <s-badge tone="critical">Gone</s-badge>}
                            <s-text type="strong">{row.name}</s-text>
                            {row.kind === "added" && row.detail && (
                              <s-text color="subdued">{`${row.detail} ${currencyCode}`}</s-text>
                            )}
                          </s-stack>
                          {(row.fields ?? []).map((field) => (
                            <s-stack key={field.label} direction="inline" gap="small" alignItems="center">
                              <s-text color="subdued">{field.label}</s-text>
                              <s-text>{`${field.before ?? "—"} → ${field.after ?? "—"}`}</s-text>
                              {typeof field.percent === "number" && field.percent !== 0 && (
                                <s-badge tone={Math.abs(field.percent) >= 20 ? "warning" : "neutral"}>
                                  {`${field.percent > 0 ? "+" : ""}${field.percent}%`}
                                </s-badge>
                              )}
                            </s-stack>
                          ))}
                        </s-stack>
                      ))}
                    </s-stack>
                  )}
                </s-stack>
              ))}
            </s-stack>
          )}
        </s-section>
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
          <s-text color="subdued">Product type</s-text>
          <s-text>{submission.productType ?? "Not set"}</s-text>
          <s-text color="subdued">Tags</s-text>
          <s-text>{submission.tags.length ? submission.tags.join(", ") : "None"}</s-text>
          <s-text color="subdued">Collections</s-text>
          <s-text>{collections.length ? collections.join(", ") : "None"}</s-text>
        </s-grid>
      </s-section>

      <s-section
        heading={
          submission.options.length
            ? `Variants (${submission.variants.length})`
            : "Pricing, inventory and shipping"
        }
      >
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Variant</s-table-header>
            <s-table-header listSlot="labeled" format="currency">
              Price
            </s-table-header>
            <s-table-header listSlot="labeled" format="currency">
              Compare-at
            </s-table-header>
            <s-table-header listSlot="labeled" format="currency">
              Cost
            </s-table-header>
            <s-table-header listSlot="labeled">Tax</s-table-header>
            <s-table-header listSlot="labeled">SKU / Barcode</s-table-header>
            <s-table-header listSlot="labeled" format="numeric">
              Available
            </s-table-header>
            <s-table-header listSlot="labeled">Shipping</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {submission.variants.map((variant, index) => {
              const name = submission.options.length
                ? submission.options.map((option) => variant.optionValues[option.name]).join(" / ")
                : "Default";
              return (
                <s-table-row key={index}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small" alignItems="center">
                      {variant.imageUrl && (
                        <s-thumbnail src={variant.imageUrl} alt={name} size="small"></s-thumbnail>
                      )}
                      <s-text>{name}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{formatMoney(variant.price, currencyCode)}</s-table-cell>
                  <s-table-cell>{formatMoney(variant.compareAtPrice, currencyCode)}</s-table-cell>
                  <s-table-cell>{formatMoney(variant.costPerItem, currencyCode)}</s-table-cell>
                  <s-table-cell>{variant.taxable ? "Charged" : "Not charged"}</s-table-cell>
                  <s-table-cell>
                    {[variant.sku, variant.barcode].filter(Boolean).join(" / ") || "—"}
                  </s-table-cell>
                  <s-table-cell>
                    {variant.trackInventory
                      ? `${variant.inventoryQuantity ?? 0}${variant.continueSelling ? " (keeps selling)" : ""}`
                      : "Not tracked"}
                  </s-table-cell>
                  <s-table-cell>{variantShipping(variant)}</s-table-cell>
                </s-table-row>
              );
            })}
          </s-table-body>
        </s-table>
      </s-section>

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
