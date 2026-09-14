import crypto from "node:crypto";
import db from "../db.server";
import { parseCommission } from "../utils/commission";
import { SHIPPING_MODES, VENDOR_STATUSES } from "../utils/vendor-display";

const INVITE_TTL_DAYS = 7;

// Which status changes the merchant can make, and from which statuses.
const TRANSITIONS = {
  approve: { from: ["PENDING", "REJECTED"], to: "ACTIVE" },
  reject: { from: ["PENDING"], to: "REJECTED" },
  suspend: { from: ["ACTIVE"], to: "SUSPENDED" },
  reactivate: { from: ["SUSPENDED"], to: "ACTIVE" },
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function slugify(value) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function uniqueHandle(shop, name) {
  const base = slugify(name) || "vendor";
  let handle = base;
  let suffix = 2;

  while (await db.vendor.findUnique({ where: { shop_handle: { shop, handle } } })) {
    handle = `${base}-${suffix}`;
    suffix += 1;
  }

  return handle;
}

// Only the SHA-256 hash is stored; the raw token is shown to the merchant once.
export function createInviteToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  return { token, tokenHash, expiresAt };
}

export function inviteUrl(token) {
  const base = process.env.VENDOR_PORTAL_URL;
  return base ? `${base.replace(/\/$/, "")}/invite/${token}` : null;
}

export function validateVendorInput({ name, email, phone }) {
  const errors = {};

  if (!name?.trim()) errors.name = "Enter the vendor's store name";
  if (!email?.trim()) errors.email = "Enter the vendor's email";
  else if (!EMAIL_PATTERN.test(email.trim())) errors.email = "Enter a valid email address";
  if (phone && phone.trim().length > 30) errors.phone = "Phone number is too long";

  return errors;
}

async function countVendorsByStatus(shop) {
  const grouped = await db.vendor.groupBy({
    by: ["status"],
    where: { shop },
    _count: { _all: true },
  });

  return Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));
}

export async function listVendors(shop, { status } = {}) {
  const where = { shop, ...(VENDOR_STATUSES.includes(status) ? { status } : {}) };

  const [vendors, counts] = await Promise.all([
    db.vendor.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { products: true } } },
    }),
    countVendorsByStatus(shop),
  ]);

  return { vendors, counts };
}

export async function getVendorOverview(shop) {
  const [counts, linkedProducts, invitedVendors, pending, productsToReview, changesToReview] = await Promise.all([
    countVendorsByStatus(shop),
    db.vendorProduct.count({ where: { shop } }),
    db.vendor.count({
      where: {
        shop,
        users: { some: { OR: [{ inviteTokenHash: { not: null } }, { status: "ACTIVE" }] } },
      },
    }),
    db.vendor.findMany({
      where: { shop, status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: 5,
    }),
    db.productSubmission.count({ where: { shop, status: "PENDING" } }),
    db.vendorChangeRequest.count({ where: { shop, status: "PENDING" } }),
  ]);

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

  return {
    counts,
    total,
    linkedProducts,
    invitedVendors,
    pending,
    productsToReview,
    changesToReview,
  };
}

export function getVendor(shop, id) {
  return db.vendor.findFirst({
    where: { id, shop },
    include: {
      users: { orderBy: { createdAt: "asc" } },
      activities: { orderBy: { createdAt: "desc" }, take: 20 },
      changeRequests: {
        where: { status: "PENDING" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true },
      },
      _count: { select: { products: true } },
    },
  });
}

// Vendors added by the merchant are approved immediately. The owner's invite link
// is created from the vendor page so the one-time token never travels in a URL.
export async function createVendor(shop, input, actor) {
  const name = input.name?.trim();
  const email = input.email?.trim().toLowerCase();
  const phone = input.phone?.trim() || null;

  const errors = validateVendorInput({ name, email, phone });
  if (Object.keys(errors).length) return { errors };

  const existing = await db.vendor.findUnique({ where: { shop_email: { shop, email } } });
  if (existing) return { errors: { email: "A vendor with this email already exists" } };

  const handle = await uniqueHandle(shop, name);

  const vendor = await db.vendor.create({
    data: {
      shop,
      name,
      handle,
      email,
      phone,
      status: "ACTIVE",
      approvedAt: new Date(),
      users: { create: { email, role: "OWNER" } },
      activities: { create: { action: "vendor.created", actor } },
    },
  });

  return { vendor };
}

export async function changeVendorStatus(shop, id, action, { reason, actor }) {
  const transition = TRANSITIONS[action];
  if (!transition) return { error: "Unknown action" };

  const vendor = await db.vendor.findFirst({ where: { id, shop } });
  if (!vendor) return { error: "Vendor not found" };

  if (!transition.from.includes(vendor.status)) {
    return { error: `This vendor is ${vendor.status.toLowerCase()} and can't be changed that way` };
  }

  const trimmedReason = reason?.trim() || null;
  if (action === "reject" && !trimmedReason) {
    return { error: "Add a reason so the vendor knows why they were rejected" };
  }

  const updated = await db.vendor.update({
    where: { id: vendor.id },
    data: {
      status: transition.to,
      statusReason: trimmedReason,
      approvedAt: transition.to === "ACTIVE" ? (vendor.approvedAt ?? new Date()) : vendor.approvedAt,
      activities: {
        create: {
          action: `vendor.${action}`,
          actor,
          ...(trimmedReason ? { details: { reason: trimmedReason } } : {}),
        },
      },
    },
  });

  return { vendor: updated };
}

// Creating a new link replaces (and so cancels) any previous one.
export async function createOwnerInvite(shop, vendorId, actor) {
  const owner = await db.vendorUser.findFirst({
    where: { vendorId, role: "OWNER", vendor: { shop } },
  });
  if (!owner) return { error: "Vendor owner not found" };
  if (owner.status !== "INVITED") return { error: "The vendor has already accepted their invite" };

  const invite = createInviteToken();

  await db.$transaction([
    db.vendorUser.update({
      where: { id: owner.id },
      data: { inviteTokenHash: invite.tokenHash, inviteExpiresAt: invite.expiresAt },
    }),
    db.vendorActivity.create({ data: { vendorId, action: "vendor.invite_created", actor } }),
  ]);

  return { inviteToken: invite.token };
}

// An invited owner's login email follows the vendor email; an active owner's
// login is managed in the vendor portal and is left unchanged.
export async function updateVendor(shop, id, input, actor) {
  const vendor = await db.vendor.findFirst({
    where: { id, shop },
    include: { users: { where: { role: "OWNER" } } },
  });
  if (!vendor) return { errors: { form: "Vendor not found" } };

  const values = {
    name: input.name?.trim(),
    email: input.email?.trim().toLowerCase(),
    phone: input.phone?.trim() || null,
  };

  const errors = validateVendorInput(values);
  if (Object.keys(errors).length) return { errors };

  if (values.email !== vendor.email) {
    const taken = await db.vendor.findUnique({
      where: { shop_email: { shop, email: values.email } },
    });
    if (taken) return { errors: { email: "A vendor with this email already exists" } };
  }

  const changed = Object.keys(values).filter((field) => values[field] !== vendor[field]);
  if (!changed.length) return { vendor, changed };

  const owner = vendor.users[0];
  const updateOwnerEmail = owner?.status === "INVITED" && changed.includes("email");

  const updated = await db.vendor.update({
    where: { id: vendor.id },
    data: {
      ...values,
      activities: { create: { action: "vendor.updated", actor, details: { fields: changed } } },
      ...(updateOwnerEmail
        ? { users: { update: { where: { id: owner.id }, data: { email: values.email } } } }
        : {}),
    },
  });

  return { vendor: updated, changed };
}

// useDefault clears the override so the store default applies.
export async function updateVendorCommission(shop, id, { useDefault, percent, fixed }, actor) {
  const vendor = await db.vendor.findFirst({ where: { id, shop } });
  if (!vendor) return { error: "Vendor not found" };

  let values = { commissionPercent: null, commissionFixed: null };
  if (!useDefault) {
    const result = parseCommission({ percent, fixed });
    if (result.errors) return { errors: result.errors };
    values = result.values;
  }

  await db.vendor.update({
    where: { id: vendor.id },
    data: {
      ...values,
      activities: {
        create: {
          action: "vendor.commission_updated",
          actor,
          details: useDefault
            ? { useDefault: true }
            : { percent: values.commissionPercent, fixed: values.commissionFixed },
        },
      },
    },
  });

  return { ok: true };
}

export async function updateVendorFulfillment(shop, id, input, actor) {
  const vendor = await db.vendor.findFirst({ where: { id, shop } });
  if (!vendor) return { error: "Vendor not found" };

  const errors = {};
  const shippingMode = String(input.shippingMode ?? "");
  const codEnabled = Boolean(input.codEnabled);
  const limitText = String(input.codMaxOrderValue ?? "").trim();

  if (!SHIPPING_MODES.includes(shippingMode)) {
    errors.shippingMode = "Choose who ships this vendor's orders";
  }
  if (codEnabled && limitText && !/^\d+(\.\d{1,2})?$/.test(limitText)) {
    errors.codMaxOrderValue = "Enter an amount with up to 2 decimal places, or leave it empty for no limit";
  }
  if (Object.keys(errors).length) return { errors };

  const values = {
    shippingMode,
    codEnabled,
    codMaxOrderValue: codEnabled && limitText ? Number(limitText).toFixed(2) : null,
  };

  await db.vendor.update({
    where: { id: vendor.id },
    data: {
      ...values,
      activities: { create: { action: "vendor.fulfillment_updated", actor, details: values } },
    },
  });

  return { ok: true };
}

export async function updateVendorNotes(shop, id, notes, actor) {
  const vendor = await db.vendor.findFirst({ where: { id, shop } });
  if (!vendor) return { error: "Vendor not found" };

  await db.vendor.update({
    where: { id: vendor.id },
    data: {
      notes: notes?.trim() || null,
      activities: { create: { action: "vendor.notes_updated", actor } },
    },
  });

  return { ok: true };
}
