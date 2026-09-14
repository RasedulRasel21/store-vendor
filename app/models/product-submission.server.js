import db from "../db.server";
import { sanitizeDescription } from "../utils/sanitize-description.server";
import { SUBMISSION_REVIEW_STATUSES } from "../utils/vendor-display";

const APPROVAL_CONTEXT = `#graphql
  query ApprovalContext {
    location {
      id
    }
    catalogs(first: 20, type: APP) {
      nodes {
        publication {
          id
        }
        ... on AppCatalog {
          apps(first: 5) {
            nodes {
              handle
            }
          }
        }
      }
    }
  }`;

// Catalog titles vary by store (for example "Channel Catalog 98808561952"), so the
// Online Store channel is identified by its app handle.
const ONLINE_STORE_APP_HANDLE = "online_store";

const CREATE_PRODUCT = `#graphql
  mutation CreateVendorProduct($input: ProductSetInput!) {
    productSet(synchronous: true, input: $input) {
      product {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }`;

const PUBLISH_PRODUCT = `#graphql
  mutation PublishVendorProduct($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors {
        field
        message
      }
    }
  }`;

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Shopify's defaults for settings that older submissions didn't have.
function withVariantDefaults(variant, submission) {
  return {
    optionValues: variant.optionValues ?? {},
    imageUrl: variant.imageUrl ?? null,
    price: variant.price ?? null,
    compareAtPrice: variant.compareAtPrice ?? null,
    costPerItem: variant.costPerItem ?? null,
    taxable: variant.taxable ?? true,
    sku: variant.sku ?? null,
    barcode: variant.barcode ?? null,
    trackInventory: variant.trackInventory ?? submission.trackInventory,
    inventoryQuantity: Number.isInteger(variant.inventoryQuantity) ? variant.inventoryQuantity : null,
    continueSelling: variant.continueSelling ?? false,
    requiresShipping: variant.requiresShipping ?? true,
    weight: variant.weight ?? null,
    weightUnit: variant.weightUnit ?? "KILOGRAMS",
    countryOfOrigin: variant.countryOfOrigin ?? null,
    hsCode: variant.hsCode ?? null,
  };
}

// New submissions store options and variants as JSON; the first portal version kept
// a single variant's fields on the submission row.
export function submissionVariants(submission) {
  if (Array.isArray(submission.variants) && submission.variants.length) {
    return submission.variants.map((variant) => withVariantDefaults(variant, submission));
  }
  return [
    withVariantDefaults(
      {
        price: submission.price === null ? null : submission.price.toFixed(2),
        compareAtPrice:
          submission.compareAtPrice === null ? null : submission.compareAtPrice.toFixed(2),
        sku: submission.sku,
        barcode: submission.barcode,
        inventoryQuantity: submission.inventoryQuantity,
      },
      submission,
    ),
  ];
}

// Every per-variant setting, in productSet's shape. A variant image must be one of the
// product images: Shopify then attaches the existing image instead of adding a copy.
function variantInput(variant, options, submission, locationId) {
  const tracked = variant.trackInventory && Boolean(locationId);
  const inventoryItem = {
    tracked,
    requiresShipping: variant.requiresShipping,
    ...(variant.sku ? { sku: variant.sku } : {}),
    ...(variant.costPerItem ? { cost: variant.costPerItem } : {}),
    ...(variant.requiresShipping && variant.weight
      ? { measurement: { weight: { value: Number(variant.weight), unit: variant.weightUnit } } }
      : {}),
    ...(variant.countryOfOrigin ? { countryCodeOfOrigin: variant.countryOfOrigin } : {}),
    ...(variant.hsCode ? { harmonizedSystemCode: variant.hsCode } : {}),
  };

  return {
    optionValues: options.length
      ? options.map((option) => ({
          optionName: option.name,
          name: variant.optionValues[option.name],
        }))
      : [{ optionName: "Title", name: "Default Title" }],
    price: variant.price,
    ...(variant.compareAtPrice ? { compareAtPrice: variant.compareAtPrice } : {}),
    ...(variant.barcode ? { barcode: variant.barcode } : {}),
    taxable: variant.taxable,
    inventoryPolicy: variant.continueSelling ? "CONTINUE" : "DENY",
    inventoryItem,
    ...(tracked && Number.isInteger(variant.inventoryQuantity)
      ? {
          inventoryQuantities: [
            { locationId, name: "available", quantity: variant.inventoryQuantity },
          ],
        }
      : {}),
    ...(variant.imageUrl && submission.imageUrls.includes(variant.imageUrl)
      ? { file: { originalSource: variant.imageUrl, contentType: "IMAGE", alt: submission.title } }
      : {}),
  };
}

export function submissionOptions(submission) {
  return Array.isArray(submission.options) ? submission.options : [];
}

// Plain-text descriptions from the first portal version: blank lines become paragraphs.
export function descriptionToHtml(text) {
  if (!text) return "";
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replace(/\r?\n/g, "<br>")}</p>`)
    .join("");
}

export async function listProductSubmissions(shop, { status }) {
  const [submissions, grouped] = await Promise.all([
    db.productSubmission.findMany({
      where: { shop, status },
      orderBy: { submittedAt: status === "PENDING" ? "asc" : "desc" },
      include: { vendor: { select: { name: true } } },
    }),
    db.productSubmission.groupBy({
      by: ["status"],
      where: { shop, status: { in: SUBMISSION_REVIEW_STATUSES } },
      _count: { _all: true },
    }),
  ]);

  const counts = Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));

  return { submissions, counts };
}

// Drafts stay private to the vendor until they're submitted.
export function getProductSubmission(shop, id) {
  return db.productSubmission.findFirst({
    where: { id, shop, status: { in: SUBMISSION_REVIEW_STATUSES } },
    include: { vendor: true },
  });
}

export async function approveProductSubmission(admin, shop, id, actor) {
  const submission = await db.productSubmission.findFirst({
    where: { id, shop },
    include: { vendor: true },
  });
  if (!submission) return { error: "Product submission not found" };
  if (submission.status !== "PENDING") return { error: "Only products awaiting approval can be approved" };
  if (submission.vendor.status !== "ACTIVE") {
    return { error: "This vendor isn't active. Reactivate the vendor before approving their products." };
  }
  const options = submissionOptions(submission);
  const variants = submissionVariants(submission);
  if (!variants.length || variants.some((variant) => !variant.price)) {
    return { error: "Every variant needs a price before it can be approved" };
  }

  // Claim the submission first so a double click can't create the product twice.
  const claim = await db.productSubmission.updateMany({
    where: { id, shop, status: "PENDING", updatedAt: submission.updatedAt },
    data: { reviewedAt: new Date() },
  });
  if (claim.count !== 1) return { error: "This product is already being reviewed. Refresh the page." };

  let productId;
  let warning = null;

  try {
    const contextResponse = await admin.graphql(APPROVAL_CONTEXT);
    const { data: context } = await contextResponse.json();
    const locationId = context?.location?.id;
    const onlineStorePublicationId = context?.catalogs?.nodes?.find((catalog) =>
      catalog.apps?.nodes?.some((app) => app.handle === ONLINE_STORE_APP_HANDLE),
    )?.publication?.id;

    const seo = {
      ...(submission.seoTitle ? { title: submission.seoTitle } : {}),
      ...(submission.seoDescription ? { description: submission.seoDescription } : {}),
    };

    const response = await admin.graphql(CREATE_PRODUCT, {
      variables: {
        input: {
          title: submission.title,
          descriptionHtml: submission.descriptionHtml
            ? sanitizeDescription(submission.descriptionHtml)
            : descriptionToHtml(submission.description),
          vendor: submission.vendor.name,
          ...(submission.productType ? { productType: submission.productType } : {}),
          ...(submission.handle ? { handle: submission.handle } : {}),
          ...(Object.keys(seo).length ? { seo } : {}),
          tags: submission.tags,
          status: "ACTIVE",
          metafields: [
            {
              namespace: "$app",
              key: "vendor_id",
              type: "single_line_text_field",
              value: submission.vendor.id,
            },
          ],
          productOptions: options.length
            ? options.map((option) => ({
                name: option.name,
                values: option.values.map((value) => ({ name: value })),
              }))
            : [{ name: "Title", values: [{ name: "Default Title" }] }],
          variants: variants.map((variant) =>
            variantInput(variant, options, submission, locationId),
          ),
          files: submission.imageUrls.map((url) => ({
            originalSource: url,
            contentType: "IMAGE",
            alt: submission.title,
          })),
        },
      },
    });
    const { data } = await response.json();

    productId = data?.productSet?.product?.id;
    if (!productId) {
      const message = data?.productSet?.userErrors?.[0]?.message;
      return { error: message ?? "Shopify couldn't create the product. Try again." };
    }

    if (onlineStorePublicationId) {
      const publishResponse = await admin.graphql(PUBLISH_PRODUCT, {
        variables: { id: productId, input: [{ publicationId: onlineStorePublicationId }] },
      });
      const { data: publishData } = await publishResponse.json();
      if (publishData?.publishablePublish?.userErrors?.length) {
        warning = "The product was created but couldn't be published to the Online Store. Publish it from the product page in Shopify.";
      }
    } else {
      warning = "The product was created, but the Online Store channel wasn't found, so it isn't published yet.";
    }
  } catch (error) {
    console.error("Product approval failed", error);
    return { error: "Shopify couldn't create the product. Check the product details and try again." };
  }

  const now = new Date();
  await db.$transaction([
    db.productSubmission.update({
      where: { id: submission.id },
      data: { status: "APPROVED", productId, reviewedAt: now, reviewNote: null },
    }),
    db.vendorProduct.upsert({
      where: { shop_productId: { shop, productId } },
      update: { vendorId: submission.vendorId },
      create: { shop, vendorId: submission.vendorId, productId },
    }),
    db.vendorActivity.create({
      data: {
        vendorId: submission.vendorId,
        action: "product.approved",
        actor,
        details: { submissionId: submission.id, productId, title: submission.title },
      },
    }),
  ]);

  return { productId, warning };
}

export async function rejectProductSubmission(shop, id, note, actor) {
  const trimmed = note?.trim();
  if (!trimmed) return { error: "Add a note so the vendor knows what to change" };
  if (trimmed.length > 2000) return { error: "Keep the note to 2,000 characters or fewer" };

  const submission = await db.productSubmission.findFirst({
    where: { id, shop, status: "PENDING" },
    select: { id: true, vendorId: true, title: true },
  });
  if (!submission) return { error: "Only products awaiting approval can be sent back" };

  await db.$transaction([
    db.productSubmission.update({
      where: { id: submission.id },
      data: { status: "REJECTED", reviewNote: trimmed, reviewedAt: new Date() },
    }),
    db.vendorActivity.create({
      data: {
        vendorId: submission.vendorId,
        action: "product.rejected",
        actor,
        details: { submissionId: submission.id, title: submission.title, reason: trimmed },
      },
    }),
  ]);

  return { ok: true };
}
