import db from "../db.server";
import { createVendor } from "./vendor.server";
import { setVendorMetafields } from "./vendor-product.server";

export const MAX_IMPORT_VENDORS = 25;
const MAX_PRODUCTS_PER_VENDOR = 1000;
const COUNT_BATCH = 25;

const PRODUCT_VENDOR_NAMES = `#graphql
  query ProductVendorNames {
    productVendors(first: 1000) {
      nodes
    }
  }`;

const PRODUCTS_BY_VENDOR = `#graphql
  query ProductsByVendor($query: String!, $after: String) {
    products(first: 250, after: $after, query: $query) {
      nodes {
        id
        vendor
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

function vendorSearch(name) {
  return `vendor:"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Vendor names used on Shopify products that aren't StoreVendor vendors yet.
export async function getImportableVendors(admin, shop) {
  const [response, existing] = await Promise.all([
    admin.graphql(PRODUCT_VENDOR_NAMES),
    db.vendor.findMany({ where: { shop }, select: { name: true } }),
  ]);
  const { data } = await response.json();

  const taken = new Set(existing.map((vendor) => vendor.name.trim().toLowerCase()));
  const names = (data?.productVendors?.nodes ?? [])
    .map((name) => name.trim())
    .filter((name) => name && !taken.has(name.toLowerCase()));

  const counts = {};
  for (let start = 0; start < names.length; start += COUNT_BATCH) {
    const batch = names.slice(start, start + COUNT_BATCH);
    const query = `#graphql
      query VendorProductCounts(${batch.map((_, i) => `$q${i}: String`).join(", ")}) {
        ${batch.map((_, i) => `v${i}: productsCount(query: $q${i}, limit: null) { count }`).join("\n")}
      }`;
    const variables = Object.fromEntries(batch.map((name, i) => [`q${i}`, vendorSearch(name)]));

    const countResponse = await admin.graphql(query, { variables });
    const { data: countData } = await countResponse.json();
    batch.forEach((name, i) => {
      counts[name] = countData?.[`v${i}`]?.count ?? 0;
    });
  }

  return names.map((name) => ({ name, productCount: counts[name] ?? 0 }));
}

async function findProductIdsByVendor(admin, name) {
  const ids = [];
  let after = null;

  do {
    const response = await admin.graphql(PRODUCTS_BY_VENDOR, {
      variables: { query: vendorSearch(name), after },
    });
    const { data } = await response.json();
    const page = data?.products;
    if (!page) break;

    // Search is fuzzy, so keep exact Vendor matches only.
    ids.push(...page.nodes.filter((product) => product.vendor === name).map((product) => product.id));
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after && ids.length < MAX_PRODUCTS_PER_VENDOR);

  return {
    ids: ids.slice(0, MAX_PRODUCTS_PER_VENDOR),
    truncated: Boolean(after) || ids.length > MAX_PRODUCTS_PER_VENDOR,
  };
}

// Creates a vendor for each selected name and links the products that carry it.
// rows: [{ name, email }]
export async function importVendors(admin, shop, rows, actor) {
  if (!rows.length) return { errors: { form: "Select at least one vendor to import" }, results: [] };
  if (rows.length > MAX_IMPORT_VENDORS) {
    return { errors: { form: `Import up to ${MAX_IMPORT_VENDORS} vendors at a time` }, results: [] };
  }

  const errors = {};
  const results = [];

  for (const row of rows) {
    const created = await createVendor(shop, { name: row.name, email: row.email }, actor);
    if (created.errors) {
      errors[row.name] = created.errors.email ?? created.errors.name ?? "Couldn't create this vendor";
      continue;
    }

    const { ids, truncated } = await findProductIdsByVendor(admin, row.name);
    const linkedElsewhere = await db.vendorProduct.findMany({
      where: { shop, productId: { in: ids } },
      select: { productId: true },
    });
    const skip = new Set(linkedElsewhere.map((link) => link.productId));

    const saved = await setVendorMetafields(
      admin,
      ids.filter((id) => !skip.has(id)),
      created.vendor.id,
    );

    if (saved.length) {
      await db.vendorProduct.createMany({
        data: saved.map((productId) => ({ shop, vendorId: created.vendor.id, productId })),
        skipDuplicates: true,
      });
    }

    await db.vendorActivity.create({
      data: {
        vendorId: created.vendor.id,
        action: "vendor.imported",
        actor,
        details: { products: saved.length },
      },
    });

    results.push({ name: row.name, products: saved.length, truncated });
  }

  return { errors, results };
}
