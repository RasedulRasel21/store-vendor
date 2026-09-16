import db from "../db.server";
import { shopifyCarriers } from "../utils/carriers";
import { getShopSettings } from "./settings.server";

// What vendors can choose from: the carriers Shopify knows in this country, plus any the
// merchant has approved because Shopify doesn't list them here.
export async function carrierChoices(shop) {
  const [settings, approved] = await Promise.all([
    getShopSettings(shop),
    db.shopCarrier.findMany({
      where: { shop, status: "APPROVED" },
      orderBy: { name: "asc" },
      select: { name: true, trackingUrlTemplate: true },
    }),
  ]);

  return {
    fromShopify: shopifyCarriers(settings.countryCode),
    approved,
  };
}

export async function allowedCarrierNames(shop) {
  const { fromShopify, approved } = await carrierChoices(shop);
  return new Set([...fromShopify, ...approved.map((carrier) => carrier.name)].map((name) => name.toLowerCase()));
}

export function listCarrierRequests(shop) {
  return db.shopCarrier.findMany({
    where: { shop },
    orderBy: [{ status: "asc" }, { name: "asc" }],
  });
}

export async function approveCarrier(shop, id, actor) {
  const carrier = await db.shopCarrier.findFirst({ where: { id, shop } });
  if (!carrier) return { error: "Courier not found" };

  await db.shopCarrier.update({
    where: { id: carrier.id },
    data: { status: "APPROVED", reviewNote: null, reviewedAt: new Date() },
  });

  if (carrier.requestedByVendorId) {
    await db.vendorActivity.create({
      data: {
        vendorId: carrier.requestedByVendorId,
        action: "carrier.approved",
        actor,
        details: { name: carrier.name },
      },
    });
  }

  return { ok: true };
}

export async function rejectCarrier(shop, id, note, actor) {
  const trimmed = note?.trim();
  if (!trimmed) return { error: "Add a note so the vendor knows why" };

  const carrier = await db.shopCarrier.findFirst({ where: { id, shop } });
  if (!carrier) return { error: "Courier not found" };

  await db.shopCarrier.update({
    where: { id: carrier.id },
    data: { status: "REJECTED", reviewNote: trimmed.slice(0, 2000), reviewedAt: new Date() },
  });

  if (carrier.requestedByVendorId) {
    await db.vendorActivity.create({
      data: {
        vendorId: carrier.requestedByVendorId,
        action: "carrier.rejected",
        actor,
        details: { name: carrier.name, reason: trimmed },
      },
    });
  }

  return { ok: true };
}

// Lets a merchant add a courier directly, without waiting for a vendor to ask.
export async function addCarrier(shop, { name, trackingUrlTemplate }) {
  const trimmed = name?.trim();
  if (!trimmed) return { error: "Enter the courier's name" };
  if (trimmed.length > 60) return { error: "Use 60 characters or fewer" };

  await db.shopCarrier.upsert({
    where: { shop_name: { shop, name: trimmed } },
    update: { status: "APPROVED", trackingUrlTemplate: trackingUrlTemplate?.trim() || null, reviewedAt: new Date() },
    create: {
      shop,
      name: trimmed,
      trackingUrlTemplate: trackingUrlTemplate?.trim() || null,
      status: "APPROVED",
      reviewedAt: new Date(),
    },
  });

  return { ok: true };
}
