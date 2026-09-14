export const VENDOR_STATUS = {
  PENDING: { label: "Pending", tone: "warning" },
  ACTIVE: { label: "Active", tone: "success" },
  SUSPENDED: { label: "Suspended", tone: "critical" },
  REJECTED: { label: "Rejected", tone: "neutral" },
};

export const VENDOR_STATUSES = Object.keys(VENDOR_STATUS);

export const VENDOR_USER_STATUS = {
  INVITED: { label: "Invited", tone: "info" },
  ACTIVE: { label: "Active", tone: "success" },
  DISABLED: { label: "Disabled", tone: "neutral" },
};

const ACTIVITY_LABELS = {
  "vendor.created": "Vendor added",
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
