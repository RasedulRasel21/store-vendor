import db from "../db.server";
import { getShopSettings } from "./settings.server";

// Manual collections only: Shopify adds products to smart collections by their rules.
const MANUAL_COLLECTIONS = "collection_type:custom";
const MAX_COLLECTIONS = 5000;

const SHOP_COLLECTIONS = `#graphql
  query ShopCollections($cursor: String, $query: String) {
    collections(first: 250, after: $cursor, sortKey: TITLE, query: $query) {
      nodes {
        id
        title
        handle
        image {
          url
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }`;

function collectionRecord(shop, collection, syncedAt) {
  return {
    shop,
    collectionId: collection.id,
    title: collection.title,
    handle: collection.handle,
    imageUrl: collection.image?.url ?? null,
    syncedAt,
  };
}

async function fetchCollections(admin, query) {
  const collections = [];
  let cursor = null;

  do {
    const response = await admin.graphql(SHOP_COLLECTIONS, { variables: { cursor, query } });
    const { data } = await response.json();
    const page = data?.collections;
    if (!page) throw new Error("Shopify didn't return the store's collections");

    collections.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor && collections.length < MAX_COLLECTIONS);

  return collections;
}

// Replaces the saved list with the store's current manual collections.
export async function syncCollections(admin, shop) {
  const collections = await fetchCollections(admin, MANUAL_COLLECTIONS);
  const now = new Date();

  await db.$transaction([
    db.shopCollection.deleteMany({
      where: { shop, collectionId: { notIn: collections.map((collection) => collection.id) } },
    }),
    ...collections.map((collection) => {
      const record = collectionRecord(shop, collection, now);
      return db.shopCollection.upsert({
        where: { shop_collectionId: { shop, collectionId: collection.id } },
        update: record,
        create: record,
      });
    }),
    db.shopSettings.upsert({
      where: { shop },
      update: { collectionsSyncedAt: now },
      create: { shop, collectionsSyncedAt: now },
    }),
  ]);

  return collections.length;
}

// The first time the app loads for a shop, fill the list; webhooks keep it current after that.
export async function ensureCollectionsSynced(admin, shop) {
  const settings = await getShopSettings(shop);
  if (settings.collectionsSyncedAt) return;
  await syncCollections(admin, shop);
}

// Refreshes one collection after a collections/create or collections/update webhook.
// A collection that's now smart is removed, because vendors can't add products to it.
export async function syncCollection(admin, shop, collectionGid) {
  const numericId = collectionGid.split("/").pop();
  const [collection] = await fetchCollections(admin, `${MANUAL_COLLECTIONS} id:${numericId}`);

  if (collection?.id !== collectionGid) {
    await removeCollection(shop, collectionGid);
    return;
  }

  const record = collectionRecord(shop, collection, new Date());
  await db.shopCollection.upsert({
    where: { shop_collectionId: { shop, collectionId: collection.id } },
    update: record,
    create: record,
  });
}

export function removeCollection(shop, collectionGid) {
  return db.shopCollection.deleteMany({ where: { shop, collectionId: collectionGid } });
}

export async function getCollectionSyncStatus(shop) {
  const [settings, count] = await Promise.all([
    getShopSettings(shop),
    db.shopCollection.count({ where: { shop } }),
  ]);
  return { count, syncedAt: settings.collectionsSyncedAt };
}

// Only collections that still exist in the store, in the order the vendor chose them.
export async function getShopCollections(shop, collectionIds) {
  if (!collectionIds?.length) return [];
  const collections = await db.shopCollection.findMany({
    where: { shop, collectionId: { in: collectionIds } },
    select: { collectionId: true, title: true },
  });
  return collectionIds
    .map((id) => collections.find((collection) => collection.collectionId === id))
    .filter(Boolean);
}
