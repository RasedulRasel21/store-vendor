import db from "../db.server";
import { getShopCollections } from "./collection.server";
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

// Everything productSet needs for a product, shared by new products and approved edits.
function productInput(source, vendor, { options, variants, collections, locationId }) {
  const seo = {
    ...(source.seoTitle ? { title: source.seoTitle } : {}),
    ...(source.seoDescription ? { description: source.seoDescription } : {}),
  };

  return {
    title: source.title,
    descriptionHtml: source.descriptionHtml
      ? sanitizeDescription(source.descriptionHtml)
      : descriptionToHtml(source.description),
    vendor: vendor.name,
    ...(source.productType ? { productType: source.productType } : {}),
    ...(source.handle ? { handle: source.handle } : {}),
    ...(Object.keys(seo).length ? { seo } : {}),
    tags: source.tags ?? [],
    ...(collections.length ? { collections: collections.map((collection) => collection.collectionId) } : {}),
    status: "ACTIVE",
    metafields: [
      {
        namespace: "$app",
        key: "vendor_id",
        type: "single_line_text_field",
        value: vendor.id,
      },
    ],
    productOptions: options.length
      ? options.map((option) => ({
          name: option.name,
          values: option.values.map((value) => ({ name: value })),
        }))
      : [{ name: "Title", values: [{ name: "Default Title" }] }],
    variants: variants.map((variant) => variantInput(variant, options, source, locationId)),
    files: (source.imageUrls ?? []).map((url) => ({
      originalSource: url,
      contentType: "IMAGE",
      alt: source.title,
    })),
  };
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

// The values to review: a vendor's proposed edit when there is one, otherwise what's live.
export function reviewedProduct(submission) {
  const draft = submission.pendingSubmittedAt ? submission.pendingDraft : null;
  return draft ? { ...submission, ...draft } : submission;
}

export async function listProductSubmissions(shop, { status }) {
  // Edits to live products are reviewed alongside new products.
  const where =
    status === "PENDING"
      ? { shop, OR: [{ status: "PENDING" }, { pendingSubmittedAt: { not: null } }] }
      : { shop, status };

  const [submissions, grouped, editCount] = await Promise.all([
    db.productSubmission.findMany({
      where,
      orderBy: { submittedAt: status === "PENDING" ? "asc" : "desc" },
      include: { vendor: { select: { name: true } } },
    }),
    db.productSubmission.groupBy({
      by: ["status"],
      where: { shop, status: { in: SUBMISSION_REVIEW_STATUSES } },
      _count: { _all: true },
    }),
    db.productSubmission.count({ where: { shop, pendingSubmittedAt: { not: null } } }),
  ]);

  const counts = Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));
  counts.PENDING = (counts.PENDING ?? 0) + editCount;

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

    // Collections deleted (or turned smart) since the vendor picked them are skipped.
    const collections = await getShopCollections(shop, submission.collectionIds);

    const response = await admin.graphql(CREATE_PRODUCT, {
      variables: {
        input: productInput(submission, submission.vendor, {
          options,
          variants,
          collections,
          locationId,
        }),
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

// Applies a vendor's edit to the product that's already live in the store.
export async function approveProductEdit(admin, shop, id, actor) {
  const submission = await db.productSubmission.findFirst({
    where: { id, shop },
    include: { vendor: true },
  });
  if (!submission) return { error: "Product not found" };
  if (!submission.pendingSubmittedAt || !submission.pendingDraft) {
    return { error: "This product has no changes waiting for approval" };
  }
  if (!submission.productId) return { error: "This product isn't in Shopify yet" };
  if (submission.vendor.status !== "ACTIVE") {
    return { error: "This vendor isn't active. Reactivate the vendor before approving their changes." };
  }

  const changes = reviewedProduct(submission);
  const options = submissionOptions(changes);
  const variants = submissionVariants(changes);
  if (!variants.length || variants.some((variant) => !variant.price)) {
    return { error: "Every variant needs a price before the changes can be approved" };
  }

  // Claim the review so two clicks can't both update the product.
  const claim = await db.productSubmission.updateMany({
    where: { id, shop, pendingSubmittedAt: { not: null }, updatedAt: submission.updatedAt },
    data: { reviewedAt: new Date() },
  });
  if (claim.count !== 1) return { error: "These changes are already being reviewed. Refresh the page." };

  try {
    const contextResponse = await admin.graphql(APPROVAL_CONTEXT);
    const { data: context } = await contextResponse.json();
    const locationId = context?.location?.id;
    const collections = await getShopCollections(shop, changes.collectionIds ?? []);

    const response = await admin.graphql(CREATE_PRODUCT, {
      variables: {
        input: {
          id: submission.productId,
          ...productInput(changes, submission.vendor, { options, variants, collections, locationId }),
        },
      },
    });
    const { data } = await response.json();

    if (!data?.productSet?.product?.id) {
      const message = data?.productSet?.userErrors?.[0]?.message;
      return { error: message ?? "Shopify couldn't update the product. Try again." };
    }
  } catch (error) {
    console.error("Product edit approval failed", error);
    return { error: "Shopify couldn't update the product. Check the details and try again." };
  }

  const { pendingDraft } = submission;
  await db.$transaction([
    db.productSubmission.update({
      where: { id: submission.id },
      data: {
        ...pendingDraft,
        pendingDraft: null,
        pendingSubmittedAt: null,
        pendingReviewNote: null,
        reviewedAt: new Date(),
      },
    }),
    db.vendorActivity.create({
      data: {
        vendorId: submission.vendorId,
        action: "product.changes_approved",
        actor,
        details: { submissionId: submission.id, title: changes.title },
      },
    }),
  ]);

  return { ok: true };
}

// Sends an edit back. The live product stays as it is, and the vendor keeps their draft.
export async function rejectProductEdit(shop, id, note, actor) {
  const trimmed = note?.trim();
  if (!trimmed) return { error: "Add a note so the vendor knows what to change" };
  if (trimmed.length > 2000) return { error: "Keep the note to 2,000 characters or fewer" };

  const submission = await db.productSubmission.findFirst({
    where: { id, shop, pendingSubmittedAt: { not: null } },
    select: { id: true, vendorId: true, title: true },
  });
  if (!submission) return { error: "This product has no changes waiting for approval" };

  await db.$transaction([
    db.productSubmission.update({
      where: { id: submission.id },
      data: { pendingSubmittedAt: null, pendingReviewNote: trimmed, reviewedAt: new Date() },
    }),
    db.vendorActivity.create({
      data: {
        vendorId: submission.vendorId,
        action: "product.changes_rejected",
        actor,
        details: { submissionId: submission.id, title: submission.title, reason: trimmed },
      },
    }),
  ]);

  return { ok: true };
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

// Approving several at once. Each one still goes through the same checks and the same
// Shopify calls as approving it on its own — this only saves the clicking, it doesn't
// take any shortcuts.
//
// They run one after another rather than together: each approval creates a product and
// uploads its images, and firing twenty of those at Shopify at once is how you meet a
// rate limit. The batch is capped for the same reason, so a request can't run past the
// time it's allowed.
export const BULK_APPROVE_LIMIT = 10;

export async function approveMany(admin, shop, ids, actor) {
  const wanted = [...new Set((ids ?? []).filter(Boolean))];
  if (!wanted.length) return { error: "Tick the products you want to approve" };

  const batch = wanted.slice(0, BULK_APPROVE_LIMIT);
  const waiting = wanted.length - batch.length;

  const rows = await db.productSubmission.findMany({
    where: { id: { in: batch }, shop },
    select: { id: true, title: true, pendingSubmittedAt: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));

  const approved = [];
  const failed = [];

  for (const id of batch) {
    const row = byId.get(id);
    if (!row) {
      failed.push({ title: "A product that's no longer there", error: "It may have been reviewed already." });
      continue;
    }

    try {
      const result = row.pendingSubmittedAt
        ? await approveProductEdit(admin, shop, id, actor)
        : await approveProductSubmission(admin, shop, id, actor);

      if (result.error) failed.push({ title: row.title, error: result.error });
      else approved.push({ title: row.title, warning: result.warning ?? null });
    } catch (error) {
      console.error(`Bulk approve failed for ${id}`, error);
      failed.push({ title: row.title, error: "Shopify couldn't be reached. Try this one on its own." });
    }
  }

  return { approved, failed, waiting };
}
