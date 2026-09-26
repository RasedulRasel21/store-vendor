import db from "../db.server";

// What the shop's own pages about its vendors need. Everything here is read by strangers,
// so it returns only what a customer may see: no email, no address, no shop domain.
//
// Products are deliberately not listed here. Shopify already serves every vendor's
// products at /collections/vendors?q=<name>, rendered by the theme with its own sorting,
// filtering and pagination, so a vendor's page links there instead of building a worse
// copy of it — and no Admin API call happens when a customer opens a page.

function card(vendor) {
  return {
    name: vendor.name,
    handle: vendor.handle,
    logoUrl: vendor.logoUrl,
    // A sentence or so, for a card in a list.
    blurb: vendor.bio ? vendor.bio.replace(/\s+/g, " ").trim().slice(0, 160) : null,
    productCount: vendor._count.products,
  };
}

// Everyone selling in this shop who has something to sell. A vendor with no products is
// left out: a page with nothing on it is worse than no link at all.
export async function vendorDirectory(shop) {
  const vendors = await db.vendor.findMany({
    where: { shop, status: "ACTIVE", products: { some: {} } },
    orderBy: { name: "asc" },
    select: {
      name: true,
      handle: true,
      logoUrl: true,
      bio: true,
      _count: { select: { products: true } },
    },
  });

  return vendors.map(card);
}

// Letters and digits only. Shopify's handleize and our own slugify disagree about
// apostrophes — "Rassel's Store" becomes rassels-store to one and rassel-s-store to the
// other — so a link built in a theme from the product's vendor name still has to find the
// right shop. Comparing them stripped of everything else settles it.
const bare = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function findVendor(shop, handle) {
  const wanted = String(handle ?? "").toLowerCase().slice(0, 80);
  const select = {
    name: true,
    handle: true,
    logoUrl: true,
    bannerUrl: true,
    bio: true,
    shippingPolicy: true,
    returnPolicy: true,
    countryCode: true,
    _count: { select: { products: true } },
  };

  const exact = await db.vendor.findFirst({ where: { shop, handle: wanted, status: "ACTIVE" }, select });
  if (exact) return exact;

  // Nothing with that handle: try the shops whose handle or name comes out the same once
  // every separator is taken away.
  const target = bare(wanted);
  if (!target) return null;

  const candidates = await db.vendor.findMany({ where: { shop, status: "ACTIVE" }, select });
  return candidates.find((v) => bare(v.handle) === target || bare(v.name) === target) ?? null;
}

export async function vendorPage(shop, handle) {
  const vendor = await findVendor(shop, handle);
  if (!vendor) return null;

  return {
    name: vendor.name,
    handle: vendor.handle,
    logoUrl: vendor.logoUrl,
    bannerUrl: vendor.bannerUrl,
    bio: vendor.bio,
    shippingPolicy: vendor.shippingPolicy,
    returnPolicy: vendor.returnPolicy,
    countryCode: vendor.countryCode,
    productCount: vendor._count.products,
    // Shopify's own listing of everything this vendor sells.
    productsUrl: `/collections/vendors?q=${encodeURIComponent(vendor.name)}`,
  };
}
