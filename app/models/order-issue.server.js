import db from "../db.server";

// Why a vendor can't ship. Kept short on purpose: the note carries the detail.
export const ISSUE_REASON = {
  OUT_OF_STOCK: "Out of stock",
  DAMAGED: "Item damaged",
  ADDRESS: "Problem with the address",
  DELAY: "Needs more time",
  OTHER: "Something else",
};

export const ISSUE_REASONS = Object.keys(ISSUE_REASON);

export function reasonLabel(reason) {
  return ISSUE_REASON[reason] ?? "Something else";
}

export function openIssueCount(shop) {
  return db.vendorOrderIssue.count({ where: { status: "OPEN", vendorOrder: { shop } } });
}

// Closing an issue is the merchant saying they've dealt with it, in Shopify or with the vendor.
export async function resolveIssue(shop, id, note, actor) {
  const issue = await db.vendorOrderIssue.findFirst({
    where: { id, vendorOrder: { shop } },
    include: { vendorOrder: { select: { vendorId: true, orderName: true } } },
  });
  if (!issue) return { error: "That request wasn't found" };
  if (issue.status !== "OPEN") return { error: "That request is already closed" };

  await db.vendorOrderIssue.update({
    where: { id: issue.id },
    data: { status: "RESOLVED", reviewNote: note?.trim().slice(0, 2000) || null, resolvedAt: new Date() },
  });

  await db.vendorActivity.create({
    data: {
      vendorId: issue.vendorOrder.vendorId,
      action: "order.issue_resolved",
      actor,
      details: { orderName: issue.vendorOrder.orderName, note: note?.trim() || null },
    },
  });

  return { ok: true };
}
