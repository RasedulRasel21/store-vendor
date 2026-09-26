import crypto from "node:crypto";
import db from "../db.server";

// The terms a store asks its vendors to agree to.
//
// Two rules shape all of this. A published version is never edited, because an
// acceptance means nothing without the exact words that were accepted; changing the
// terms means publishing a new version, and everyone agrees again. And a shop with no
// published agreement has no agreement — nothing is demanded of anyone by default.

export const MAX_BODY = 60_000;

export function currentAgreement(shop) {
  return db.vendorAgreement.findFirst({
    where: { shop, publishedAt: { not: null } },
    orderBy: { version: "desc" },
  });
}

export function draftAgreement(shop) {
  return db.vendorAgreement.findFirst({ where: { shop, publishedAt: null }, orderBy: { version: "desc" } });
}

export async function agreementOverview(shop) {
  const [current, draft] = await Promise.all([currentAgreement(shop), draftAgreement(shop)]);

  const [accepted, owing] = current
    ? await Promise.all([
        db.vendorAgreementAcceptance.count({ where: { agreementId: current.id } }),
        db.vendor.count({
          where: {
            shop,
            status: "ACTIVE",
            agreementAcceptances: { none: { agreementId: current.id } },
          },
        }),
      ])
    : [0, 0];

  return { current, draft, accepted, owing };
}

async function nextVersion(shop) {
  const latest = await db.vendorAgreement.findFirst({
    where: { shop },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  return (latest?.version ?? 0) + 1;
}

// Saving without publishing: the merchant can write it over several sittings, and nobody
// is asked to agree to a half-written page.
export async function saveAgreementDraft(shop, { title, body }) {
  const text = String(body ?? "").trim();
  const heading = String(title ?? "").trim().slice(0, 200) || "Seller agreement";
  if (!text) return { errors: { body: "Write the terms before saving them" } };
  if (text.length > MAX_BODY) return { errors: { body: "That's longer than we can store. Link to a document instead." } };

  const draft = await draftAgreement(shop);
  if (draft) {
    await db.vendorAgreement.update({ where: { id: draft.id }, data: { title: heading, body: text } });
    return { saved: true, version: draft.version };
  }

  const version = await nextVersion(shop);
  await db.vendorAgreement.create({ data: { shop, version, title: heading, body: text } });
  return { saved: true, version };
}

// Publishing is the moment it starts to matter: from here it can't be edited, and every
// vendor is asked to agree to it before they can carry on.
export async function publishAgreement(shop) {
  const draft = await draftAgreement(shop);
  if (!draft) return { error: "There's nothing waiting to be published" };
  if (!draft.body.trim()) return { error: "Write the terms first" };

  await db.vendorAgreement.update({ where: { id: draft.id }, data: { publishedAt: new Date() } });
  return { published: true, version: draft.version };
}

export async function discardAgreementDraft(shop) {
  const draft = await draftAgreement(shop);
  if (draft) await db.vendorAgreement.delete({ where: { id: draft.id } });
  return { ok: true };
}

// What one vendor needs to do, if anything: the agreement they haven't accepted yet.
export async function agreementOwedBy(shop, vendorId) {
  const current = await currentAgreement(shop);
  if (!current) return null;

  const accepted = await db.vendorAgreementAcceptance.findUnique({
    where: { agreementId_vendorId: { agreementId: current.id, vendorId } },
    select: { id: true },
  });
  return accepted ? null : current;
}

export async function agreementHistoryFor(shop, vendorId) {
  return db.vendorAgreementAcceptance.findMany({
    where: { shop, vendorId },
    orderBy: { acceptedAt: "desc" },
    include: { agreement: { select: { version: true, title: true } } },
  });
}

function signerHash(ip) {
  if (!ip) return null;
  const key = process.env.ENCRYPTION_KEY ?? process.env.SHOPIFY_API_SECRET ?? "";
  return crypto.createHmac("sha256", key).update(ip).digest("hex").slice(0, 32);
}

// A typed name is the signature. It has to be a real attempt at their own name, because
// a record saying someone signed "x" is not worth keeping.
export async function acceptAgreement(shop, vendorId, { agreementId, signedName, vendorUserId, email, ip }) {
  const current = await currentAgreement(shop);
  if (!current) return { error: "This store has no agreement to accept." };
  if (agreementId && agreementId !== current.id) {
    return { error: "The terms changed while you were reading. Read them again and accept." };
  }

  const name = String(signedName ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 3) return { errors: { signedName: "Type your full name as your signature" } };
  if (name.length > 120) return { errors: { signedName: "That's longer than a name" } };
  if (!/\p{L}/u.test(name)) return { errors: { signedName: "Type your name, in letters" } };

  await db.vendorAgreementAcceptance.upsert({
    where: { agreementId_vendorId: { agreementId: current.id, vendorId } },
    update: {},
    create: {
      agreementId: current.id,
      shop,
      vendorId,
      vendorUserId: vendorUserId ?? null,
      signedName: name,
      signedEmail: String(email ?? "").trim().toLowerCase().slice(0, 120),
      signerHash: signerHash(ip),
    },
  });

  await db.vendorActivity.create({
    data: {
      vendorId,
      action: "vendor.agreement_accepted",
      actor: vendorUserId ? `vendor_user:${vendorUserId}` : "vendor",
      details: { version: current.version, signedName: name },
    },
  });

  return { ok: true, version: current.version };
}
