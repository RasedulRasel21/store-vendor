import db from "../db.server";
import { CHANGE_REQUEST_STATUSES } from "../utils/vendor-display";

export async function listChangeRequests(shop, { status }) {
  const [requests, grouped] = await Promise.all([
    db.vendorChangeRequest.findMany({
      where: { shop, status },
      orderBy: { createdAt: status === "PENDING" ? "asc" : "desc" },
      include: { vendor: { select: { id: true, name: true } } },
    }),
    db.vendorChangeRequest.groupBy({
      by: ["status"],
      where: { shop, status: { in: CHANGE_REQUEST_STATUSES } },
      _count: { _all: true },
    }),
  ]);

  const counts = Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));

  return { requests, counts };
}

export function getChangeRequest(shop, id) {
  return db.vendorChangeRequest.findFirst({
    where: { id, shop, status: { in: CHANGE_REQUEST_STATUSES } },
    include: { vendor: true },
  });
}

export async function approveChangeRequest(shop, id, actor) {
  const request = await db.vendorChangeRequest.findFirst({ where: { id, shop } });
  if (!request) return { error: "Change request not found" };
  if (request.status !== "PENDING") return { error: "Only requests awaiting approval can be approved" };

  const { method, details } = request.requested ?? {};
  if (!method || !details) return { error: "This request has no payout details to apply" };

  // Claim the request first, so a vendor withdrawing it at the same moment can't race the approval.
  const now = new Date();
  const claim = await db.vendorChangeRequest.updateMany({
    where: { id, shop, status: "PENDING" },
    data: { status: "APPROVED", reviewedAt: now, reviewNote: null },
  });
  if (claim.count !== 1) {
    return { error: "The vendor withdrew or replaced this request. Refresh the page." };
  }

  await db.$transaction([
    db.vendor.update({
      where: { id: request.vendorId },
      data: { payoutMethod: method, payoutDetails: details, payoutUpdatedAt: now },
    }),
    db.vendorActivity.create({
      data: {
        vendorId: request.vendorId,
        action: "vendor.payout_change_approved",
        actor,
        details: { requestId: request.id, method },
      },
    }),
  ]);

  return { ok: true };
}

export async function rejectChangeRequest(shop, id, note, actor) {
  const trimmed = note?.trim();
  if (!trimmed) return { error: "Add a note so the vendor knows why" };
  if (trimmed.length > 2000) return { error: "Keep the note to 2,000 characters or fewer" };

  const request = await db.vendorChangeRequest.findFirst({
    where: { id, shop, status: "PENDING" },
    select: { id: true, vendorId: true },
  });
  if (!request) return { error: "Only requests awaiting approval can be rejected" };

  const now = new Date();
  const claim = await db.vendorChangeRequest.updateMany({
    where: { id, shop, status: "PENDING" },
    data: { status: "REJECTED", reviewNote: trimmed, reviewedAt: now },
  });
  if (claim.count !== 1) {
    return { error: "The vendor withdrew or replaced this request. Refresh the page." };
  }

  await db.vendorActivity.create({
    data: {
      vendorId: request.vendorId,
      action: "vendor.payout_change_rejected",
      actor,
      details: { requestId: request.id, reason: trimmed },
    },
  });

  return { ok: true };
}
