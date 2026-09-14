import db from "../db.server";

const VENDOR_METAFIELD = { namespace: "$app", key: "vendor_id" };
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;

const PRODUCTS_BY_ID = `#graphql
  query VendorProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        status
      }
    }
  }`;

const LINK_PRODUCT = `#graphql
  mutation LinkProductToVendor($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
      }
      userErrors {
        field
        message
      }
    }
  }`;

const UNLINK_PRODUCT = `#graphql
  mutation UnlinkProductFromVendor($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields {
        key
      }
      userErrors {
        field
        message
      }
    }
  }`;

export async function getVendorProducts(admin, shop, vendorId) {
  const links = await db.vendorProduct.findMany({
    where: { shop, vendorId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  if (!links.length) return [];

  const response = await admin.graphql(PRODUCTS_BY_ID, {
    variables: { ids: links.map((link) => link.productId) },
  });
  const { data } = await response.json();
  const products = new Map(data.nodes.filter(Boolean).map((node) => [node.id, node]));

  return links.map((link) => {
    const product = products.get(link.productId);
    return {
      id: link.productId,
      title: product?.title ?? "Deleted product",
      status: product?.status ?? null,
    };
  });
}

// Links products to a vendor: sets the product's Vendor field, stores the vendor ID
// in an app-owned metafield, and records the mapping.
export async function linkProducts(admin, shop, vendorId, productIds, actor) {
  const vendor = await db.vendor.findFirst({ where: { id: vendorId, shop } });
  if (!vendor) return { error: "Vendor not found" };

  const ids = [...new Set(productIds.filter((id) => PRODUCT_GID.test(id)))];
  if (!ids.length) return { error: "Select at least one product" };

  const existing = await db.vendorProduct.findMany({
    where: { shop, productId: { in: ids } },
    include: { vendor: { select: { name: true } } },
  });

  const ownedByOthers = existing.filter((link) => link.vendorId !== vendor.id);
  if (ownedByOthers.length) {
    const names = [...new Set(ownedByOthers.map((link) => link.vendor.name))].join(", ");
    return {
      error: `${ownedByOthers.length} of the selected products already belong to ${names}. Unlink them from that vendor first.`,
    };
  }

  const alreadyLinked = new Set(existing.map((link) => link.productId));
  let linked = 0;
  let failed = 0;

  for (const productId of ids.filter((id) => !alreadyLinked.has(id))) {
    const response = await admin.graphql(LINK_PRODUCT, {
      variables: {
        product: {
          id: productId,
          vendor: vendor.name,
          metafields: [{ ...VENDOR_METAFIELD, type: "single_line_text_field", value: vendor.id }],
        },
      },
    });
    const { data } = await response.json();

    if (!data?.productUpdate?.product || data.productUpdate.userErrors.length) {
      failed += 1;
      continue;
    }

    await db.vendorProduct.create({ data: { shop, vendorId: vendor.id, productId } });
    linked += 1;
  }

  if (linked) {
    await db.vendorActivity.create({
      data: { vendorId: vendor.id, action: "vendor.products_linked", actor, details: { count: linked } },
    });
  }

  return { linked, failed };
}

export async function unlinkProduct(admin, shop, vendorId, productId, actor) {
  const link = await db.vendorProduct.findFirst({ where: { shop, vendorId, productId } });
  if (!link) return { error: "This product isn't linked to this vendor" };

  // A deleted product has no metafield left to remove, so the mapping is dropped either way.
  await admin.graphql(UNLINK_PRODUCT, {
    variables: { metafields: [{ ownerId: productId, ...VENDOR_METAFIELD }] },
  });

  await db.$transaction([
    db.vendorProduct.delete({ where: { id: link.id } }),
    db.vendorActivity.create({ data: { vendorId, action: "vendor.product_unlinked", actor } }),
  ]);

  return { ok: true };
}
