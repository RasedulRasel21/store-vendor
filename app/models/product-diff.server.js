import db from "../db.server";

// What a vendor actually changed about a live product, so the merchant reviews the change
// rather than re-reading the whole product and trying to spot it. The live values are on
// the submission itself; what they're proposing is in pendingDraft.

const money = (value) => (value === null || value === undefined || value === "" ? null : String(value));

function plain(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const sameList = (a = [], b = []) => a.length === b.length && a.every((value, i) => value === b[i]);

// A variant is recognised across an edit by the options that make it, not by position: a
// vendor who reorders their variants hasn't changed any of them.
function variantKey(variant, index) {
  const values = variant?.optionValues;
  if (values && typeof values === "object") {
    const parts = Object.keys(values)
      .sort()
      .map((name) => `${name}=${values[name]}`);
    if (parts.length) return parts.join(" / ");
  }
  return `#${index + 1}`;
}

const VARIANT_FIELDS = [
  { key: "price", label: "price", money: true },
  { key: "compareAtPrice", label: "compare-at price", money: true },
  { key: "sku", label: "SKU" },
  { key: "barcode", label: "barcode" },
  { key: "inventoryQuantity", label: "stock" },
  { key: "weight", label: "weight" },
];

function variantChanges(before = [], after = []) {
  const oldOnes = new Map((before ?? []).map((v, i) => [variantKey(v, i), v]));
  const newOnes = new Map((after ?? []).map((v, i) => [variantKey(v, i), v]));
  const rows = [];

  for (const [key, variant] of newOnes) {
    const old = oldOnes.get(key);
    if (!old) {
      rows.push({ name: key, kind: "added", detail: money(variant.price) });
      continue;
    }
    const fields = VARIANT_FIELDS.filter((field) => {
      const a = field.money ? money(old[field.key]) : (old[field.key] ?? null);
      const b = field.money ? money(variant[field.key]) : (variant[field.key] ?? null);
      return String(a ?? "") !== String(b ?? "");
    }).map((field) => ({
      label: field.label,
      before: field.money ? money(old[field.key]) : (old[field.key] ?? null),
      after: field.money ? money(variant[field.key]) : (variant[field.key] ?? null),
      // How far a price moved, which is the thing a merchant most wants to notice.
      percent:
        field.key === "price" && Number(old.price) > 0
          ? Math.round(((Number(variant.price) - Number(old.price)) / Number(old.price)) * 100)
          : null,
    }));
    if (fields.length) rows.push({ name: key, kind: "changed", fields });
  }

  for (const [key] of oldOnes) {
    if (!newOnes.has(key)) rows.push({ name: key, kind: "removed" });
  }

  return rows;
}

const TEXT_FIELDS = [
  { key: "title", label: "Title" },
  { key: "productType", label: "Product type" },
  { key: "handle", label: "URL handle" },
  { key: "seoTitle", label: "Search engine title" },
  { key: "seoDescription", label: "Search engine description" },
];

// Returns null when a submission isn't an edit, so callers can tell "no proposal" from
// "a proposal that changes nothing".
export async function productDiff(submission) {
  if (!submission?.pendingSubmittedAt || !submission.pendingDraft) return null;

  const draft = submission.pendingDraft;
  const has = (key) => Object.prototype.hasOwnProperty.call(draft, key);
  const changes = [];

  for (const field of TEXT_FIELDS) {
    if (!has(field.key)) continue;
    const before = submission[field.key] ?? "";
    const after = draft[field.key] ?? "";
    if (String(before) !== String(after)) {
      changes.push({ kind: "text", label: field.label, before: String(before), after: String(after) });
    }
  }

  if (has("descriptionHtml") || has("description")) {
    const before = plain(submission.descriptionHtml ?? submission.description);
    const after = plain(draft.descriptionHtml ?? draft.description);
    if (before !== after) {
      changes.push({ kind: "text", label: "Description", before, after });
    }
  }

  if (has("tags") && !sameList(submission.tags ?? [], draft.tags ?? [])) {
    const before = submission.tags ?? [];
    const after = draft.tags ?? [];
    changes.push({
      kind: "list",
      label: "Tags",
      added: after.filter((tag) => !before.includes(tag)),
      removed: before.filter((tag) => !after.includes(tag)),
    });
  }

  if (has("collectionIds") && !sameList(submission.collectionIds ?? [], draft.collectionIds ?? [])) {
    const before = submission.collectionIds ?? [];
    const after = draft.collectionIds ?? [];
    const ids = [...new Set([...before, ...after])];
    const collections = ids.length
      ? await db.shopCollection.findMany({
          where: { shop: submission.shop, collectionId: { in: ids } },
          select: { collectionId: true, title: true },
        })
      : [];
    const title = (id) => collections.find((c) => c.collectionId === id)?.title ?? id;
    changes.push({
      kind: "list",
      label: "Collections",
      added: after.filter((id) => !before.includes(id)).map(title),
      removed: before.filter((id) => !after.includes(id)).map(title),
    });
  }

  if (has("imageUrls") && !sameList(submission.imageUrls ?? [], draft.imageUrls ?? [])) {
    const before = submission.imageUrls ?? [];
    const after = draft.imageUrls ?? [];
    changes.push({
      kind: "images",
      label: "Images",
      added: after.filter((url) => !before.includes(url)),
      removed: before.filter((url) => !after.includes(url)),
      reordered:
        before.length === after.length &&
        after.every((url) => before.includes(url)) &&
        !sameList(before, after),
    });
  }

  if (has("trackInventory") && Boolean(submission.trackInventory) !== Boolean(draft.trackInventory)) {
    changes.push({
      kind: "text",
      label: "Track stock",
      before: submission.trackInventory ? "Yes" : "No",
      after: draft.trackInventory ? "Yes" : "No",
    });
  }

  if (has("variants")) {
    const rows = variantChanges(submission.variants, draft.variants);
    if (rows.length) changes.push({ kind: "variants", label: "Variants", rows });
  }

  // The steepest price move anywhere in the product, for the line at the top.
  const moves = changes
    .filter((change) => change.kind === "variants")
    .flatMap((change) => change.rows)
    .flatMap((row) => row.fields ?? [])
    .map((field) => field.percent)
    .filter((percent) => typeof percent === "number" && percent !== 0);

  return {
    changes,
    biggestPriceMove: moves.length
      ? moves.reduce((worst, percent) => (Math.abs(percent) > Math.abs(worst) ? percent : worst), 0)
      : null,
  };
}
