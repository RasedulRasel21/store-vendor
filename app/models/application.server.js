import crypto from "node:crypto";
import db from "../db.server";
import { slugify } from "./vendor.server";
import { COUNTRY_NAMES } from "../utils/countries";

// People applying to sell in a store. The form is public, so everything here assumes the
// sender is a stranger: the shop is found by a handle rather than named in the request,
// every field is checked and cut to length, and there are limits on how fast applications
// can arrive.
//
// An accepted application becomes a vendor with status PENDING, which is the same thing
// the merchant approves, rejects and reads as a vendor added by hand. Nothing new to
// review in a second place.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_PER_HOUR = 5;
const HOUR = 60 * 60 * 1000;

export const CATALOGUE_SIZES = [
  { value: "1-10", label: "1 to 10 products" },
  { value: "11-50", label: "11 to 50" },
  { value: "51-200", label: "51 to 200" },
  { value: "200+", label: "More than 200" },
];

// The store's own address for the form. Made once from the shop's name, and kept even if
// the shop is renamed, because by then it's a link people have.
export async function ensureApplyHandle(shop) {
  const settings = await db.shopSettings.findUnique({
    where: { shop },
    select: { applyHandle: true, shopName: true },
  });
  if (settings?.applyHandle) return settings.applyHandle;

  const base = slugify(settings?.shopName || shop.replace(/\.myshopify\.com$/, "")) || "store";
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const handle = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const taken = await db.shopSettings.findUnique({ where: { applyHandle: handle }, select: { shop: true } });
    if (!taken) {
      await db.shopSettings.update({ where: { shop }, data: { applyHandle: handle } });
      return handle;
    }
    if (taken.shop === shop) return handle;
  }

  // Every readable name was taken; fall back to something that can't be.
  const unique = `${base}-${crypto.randomBytes(3).toString("hex")}`;
  await db.shopSettings.update({ where: { shop }, data: { applyHandle: unique } });
  return unique;
}

export function applyUrl(handle) {
  const base = process.env.VENDOR_PORTAL_URL;
  return handle && base ? `${base.replace(/\/$/, "")}/apply/${handle}` : null;
}

// What the public form needs to draw itself. Returns only what a stranger may see: never
// the shop domain, never a setting.
export async function publicForm(handle) {
  const settings = await db.shopSettings.findUnique({
    where: { applyHandle: String(handle ?? "").toLowerCase().slice(0, 80) },
    select: { shop: true, shopName: true, applyOpen: true, applyIntro: true, applyTermsUrl: true },
  });
  if (!settings) return null;

  return {
    storeName: settings.shopName || settings.shop.replace(/\.myshopify\.com$/, ""),
    open: settings.applyOpen,
    intro: settings.applyIntro,
    termsUrl: settings.applyTermsUrl,
    catalogueSizes: CATALOGUE_SIZES,
  };
}

const text = (value, max) => String(value ?? "").trim().slice(0, max);

function validate(input) {
  const errors = {};
  const values = {
    name: text(input.name, 80),
    contactName: text(input.contactName, 80),
    email: text(input.email, 120).toLowerCase(),
    phone: text(input.phone, 30),
    countryCode: text(input.countryCode, 2).toUpperCase(),
    website: text(input.website, 200),
    sells: text(input.sells, 500),
    catalogueSize: text(input.catalogueSize, 10),
    message: text(input.message, 1000),
  };

  if (!values.name) errors.name = "Enter the name you sell under";
  if (!values.contactName) errors.contactName = "Enter your name";
  if (!values.email) errors.email = "Enter your email";
  else if (!EMAIL.test(values.email)) errors.email = "Enter a valid email address";
  if (!values.countryCode) errors.countryCode = "Choose where you're based";
  else if (!COUNTRY_NAMES[values.countryCode]) errors.countryCode = "Choose where you're based";
  if (!values.sells) errors.sells = "Say what you'd like to sell";
  if (values.website && !/^https?:\/\/\S+\.\S+/.test(values.website)) {
    errors.website = "Use a full address, starting with https://";
  }
  if (values.catalogueSize && !CATALOGUE_SIZES.some((size) => size.value === values.catalogueSize)) {
    errors.catalogueSize = "Choose roughly how many products you have";
  }
  if (!input.agreedTerms) errors.agreedTerms = "Tick to say you accept the terms";

  return { errors, values };
}

// A hash, not the address itself: enough to tell two applications came from the same
// place, useless for anything else, and it needs the app's own key to compute.
function applicantHash(ip) {
  if (!ip) return null;
  const key = process.env.ENCRYPTION_KEY ?? process.env.SHOPIFY_API_SECRET ?? "";
  return crypto.createHmac("sha256", key).update(ip).digest("hex").slice(0, 32);
}

async function uniqueHandleFor(shop, name) {
  const base = slugify(name) || "vendor";
  let handle = base;
  let suffix = 2;
  while (await db.vendor.findUnique({ where: { shop_handle: { shop, handle } } })) {
    handle = `${base}-${suffix}`;
    suffix += 1;
  }
  return handle;
}

export async function submitApplication(handle, input, { ip, elapsedMs } = {}) {
  const settings = await db.shopSettings.findUnique({
    where: { applyHandle: String(handle ?? "").toLowerCase().slice(0, 80) },
    select: { shop: true, applyOpen: true },
  });
  if (!settings) return { error: "This store isn't taking applications." };
  if (!settings.applyOpen) return { closed: true, error: "This store isn't taking new vendors right now." };

  // A field nobody can see, filled in only by something that fills in every field, and a
  // form sent faster than it can be read. Both are quietly accepted and thrown away, so
  // whatever sent them learns nothing.
  if (text(input.website2, 100) || (typeof elapsedMs === "number" && elapsedMs >= 0 && elapsedMs < 2000)) {
    return { ok: true, ignored: true };
  }

  const { errors, values } = validate(input);
  if (Object.keys(errors).length) return { errors };

  const existing = await db.vendor.findUnique({
    where: { shop_email: { shop: settings.shop, email: values.email } },
    select: { status: true },
  });
  if (existing) {
    // Never say whether an address is already a vendor here: that would turn the form into
    // a way of asking who sells in this store.
    return { ok: true, duplicate: true };
  }

  const fingerprint = applicantHash(ip);
  if (fingerprint) {
    const recent = await db.vendor.count({
      where: {
        shop: settings.shop,
        applicantHash: fingerprint,
        appliedAt: { gte: new Date(Date.now() - HOUR) },
      },
    });
    if (recent >= MAX_PER_HOUR) {
      return { error: "That's a lot of applications from one place. Try again in an hour." };
    }
  }

  const now = new Date();
  const vendor = await db.vendor.create({
    data: {
      shop: settings.shop,
      name: values.name,
      handle: await uniqueHandleFor(settings.shop, values.name),
      email: values.email,
      phone: values.phone || null,
      countryCode: values.countryCode,
      status: "PENDING",
      appliedAt: now,
      applicantHash: fingerprint,
      application: {
        contactName: values.contactName,
        website: values.website || null,
        sells: values.sells,
        catalogueSize: values.catalogueSize || null,
        message: values.message || null,
        agreedTerms: true,
      },
      // The login is created now but has no invite token, so it can't be used until the
      // merchant approves and sends one.
      users: { create: { email: values.email, role: "OWNER" } },
      activities: { create: { action: "vendor.applied", actor: "applicant" } },
    },
    select: { id: true },
  });

  return { ok: true, vendorId: vendor.id };
}

export async function updateApplicationSettings(shop, { open, intro, termsUrl }) {
  const url = text(termsUrl, 300);
  if (url && !/^https?:\/\/\S+\.\S+/.test(url)) {
    return { errors: { termsUrl: "Use a full address, starting with https://" } };
  }

  await db.shopSettings.update({
    where: { shop },
    data: {
      applyOpen: Boolean(open),
      applyIntro: text(intro, 500) || null,
      applyTermsUrl: url || null,
    },
  });
  return { saved: true };
}
