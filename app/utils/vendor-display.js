export const VENDOR_STATUS = {
  PENDING: { label: "Pending", tone: "warning" },
  ACTIVE: { label: "Active", tone: "success" },
  SUSPENDED: { label: "Suspended", tone: "critical" },
  REJECTED: { label: "Rejected", tone: "neutral" },
};

export const VENDOR_STATUSES = Object.keys(VENDOR_STATUS);

export const SHIPPING_MODE = {
  VENDOR_SHIPS: {
    label: "Vendor ships",
    details: "The vendor packs and ships their own order lines and adds tracking.",
  },
  STORE_SHIPS: {
    label: "Store ships",
    details: "The vendor sends stock to you, and you fulfill their orders.",
  },
};

export const SHIPPING_MODES = Object.keys(SHIPPING_MODE);

// Merchants only see submissions once a vendor submits them, so drafts aren't listed.
export const SUBMISSION_REVIEW_STATUS = {
  PENDING: { label: "Awaiting approval", tone: "warning" },
  APPROVED: { label: "Approved", tone: "success" },
  REJECTED: { label: "Changes requested", tone: "critical" },
};

export const SUBMISSION_REVIEW_STATUSES = Object.keys(SUBMISSION_REVIEW_STATUS);

// Cancelled requests were withdrawn or replaced by the vendor, so merchants don't see them.
export const CHANGE_REQUEST_STATUS = {
  PENDING: { label: "Awaiting approval", tone: "warning" },
  APPROVED: { label: "Approved", tone: "success" },
  REJECTED: { label: "Rejected", tone: "critical" },
};

export const CHANGE_REQUEST_STATUSES = Object.keys(CHANGE_REQUEST_STATUS);

export const CHANGE_REQUEST_TYPE = {
  PAYOUT: "Payout details",
};

export const VENDOR_ORDER_STATUS = {
  OPEN: { label: "To ship", tone: "warning" },
  PARTIAL: { label: "Partly shipped", tone: "info" },
  FULFILLED: { label: "Shipped", tone: "success" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

export const VENDOR_ORDER_STATUSES = Object.keys(VENDOR_ORDER_STATUS);

export const VENDOR_USER_STATUS = {
  INVITED: { label: "Invited", tone: "info" },
  ACTIVE: { label: "Active", tone: "success" },
  DISABLED: { label: "Disabled", tone: "neutral" },
};

const ACTIVITY_LABELS = {
  "vendor.created": "Vendor added",
  "vendor.updated": "Details updated",
  "vendor.imported": "Imported from Shopify",
  "vendor.commission_updated": "Commission changed",
  "vendor.fulfillment_updated": "Shipping and COD changed",
  "vendor_user.invite_accepted": "Portal invite accepted",
  "vendor.contact_updated": "Contact details updated by vendor",
  "order.received": "Order received",
  "order.fulfilled": "Order marked shipped",
  "order.partly_fulfilled": "Part of an order shipped",
  "order.refunded": "Order refunded",
  "vendor.payout_change_requested": "Payout change requested",
  "vendor.payout_change_cancelled": "Payout change request withdrawn",
  "vendor.payout_change_approved": "Payout change approved",
  "vendor.payout_change_rejected": "Payout change rejected",
  "product.submitted": "Product submitted for approval",
  "product.approved": "Product approved",
  "product.changes_submitted": "Product changes submitted",
  "product.changes_approved": "Product changes approved",
  "product.changes_rejected": "Product changes sent back",
  "product.rejected": "Product changes requested",
  "vendor.approve": "Approved",
  "vendor.reject": "Rejected",
  "vendor.suspend": "Suspended",
  "vendor.reactivate": "Reactivated",
  "vendor.notes_updated": "Notes updated",
  "vendor.invite_created": "Invite link created",
  "vendor.products_linked": "Products linked",
  "vendor.product_unlinked": "Product unlinked",
};

export function activityLabel(action) {
  return ACTIVITY_LABELS[action] ?? action;
}

// Format on the server so the rendered date matches during hydration.
const dateFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

export function formatDate(value) {
  return value ? dateFormat.format(new Date(value)) : null;
}
