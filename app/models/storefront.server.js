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

export async function vendorPage(shop, handle) {
  const vendor = await db.vendor.findFirst({
    where: { shop, handle: String(handle ?? "").toLowerCase().slice(0, 80), status: "ACTIVE" },
    select: {
      name: true,
      handle: true,
      logoUrl: true,
      bannerUrl: true,
      bio: true,
      shippingPolicy: true,
      returnPolicy: true,
      countryCode: true,
      _count: { select: { products: true } },
    },
  });
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
