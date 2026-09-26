import db from "../db.server";

// What a store asks of a product before a vendor may submit it. The rules live here and
// nowhere else: the portal asks this before it accepts a submission, and the review page
// asks it again so the merchant can see what a product falls short on. Written twice,
// they would drift apart, and a vendor would be told one thing and the merchant another.

export const RULE_LIMITS = { images: 10, products: 10_000, words: 100 };

export function listingRules(settings) {
  return {
    minImages: Math.max(0, Math.min(settings?.minProductImages ?? 0, RULE_LIMITS.images)),
    requireDescription: Boolean(settings?.requireDescription),
    requireProductType: Boolean(settings?.requireProductType),
    bannedWords: settings?.bannedWords ?? [],
    maxProducts: Math.max(0, settings?.maxProductsPerVendor ?? 0),
  };
}

export function hasAnyRule(rules) {
  return (
    rules.minImages > 0 ||
    rules.requireDescription ||
    rules.requireProductType ||
    rules.bannedWords.length > 0 ||
    rules.maxProducts > 0
  );
}

function plainText(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Whole words only, so a store banning "ale" doesn't also ban "sale".
function bannedIn(text, words) {
  const haystack = ` ${text.toLowerCase()} `;
  return words.filter((word) => {
    const needle = word.trim().toLowerCase();
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "u").test(haystack);
  });
}

// `product` is what a vendor is trying to submit: { title, descriptionHtml, productType,
// imageUrls }. Returns a list of plain sentences, empty when the product is fine.
export function breaksRules(rules, product, { productCount } = {}) {
  const problems = [];

  const images = product?.imageUrls?.length ?? 0;
  if (rules.minImages > 0 && images < rules.minImages) {
    problems.push(
      images === 0
        ? `This store asks for at least ${rules.minImages} ${rules.minImages === 1 ? "photo" : "photos"}, and there are none.`
        : `This store asks for at least ${rules.minImages} photos; there ${images === 1 ? "is 1" : `are ${images}`}.`,
    );
  }

  const description = plainText(product?.descriptionHtml ?? product?.description);
  if (rules.requireDescription && !description) {
    problems.push("This store asks every product for a description.");
  }

  if (rules.requireProductType && !String(product?.productType ?? "").trim()) {
    problems.push("This store asks every product for a product type.");
  }

  if (rules.bannedWords.length) {
    const found = [
      ...new Set([
        ...bannedIn(String(product?.title ?? ""), rules.bannedWords),
        ...bannedIn(description, rules.bannedWords),
      ]),
    ];
    if (found.length) {
      problems.push(
        `This store doesn't allow ${found.length === 1 ? "the word" : "the words"} ${found.map((word) => `"${word}"`).join(", ")}.`,
      );
    }
  }

  // Only counted when a new product would push them over: an edit to something they
  // already have doesn't add to the total.
  if (rules.maxProducts > 0 && typeof productCount === "number" && productCount >= rules.maxProducts) {
    problems.push(
      `This store allows ${rules.maxProducts} products per seller, and you have ${productCount}.`,
    );
  }

  return problems;
}

// Everything a caller needs in one go: the shop's rules, and how this vendor's product
// measures up. `submissionId` is left out when the product is new, so it isn't counted
// against the cap as well as itself.
export async function checkProduct(shop, vendorId, product, { submissionId } = {}) {
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  const rules = listingRules(settings);
  if (!hasAnyRule(rules)) return { problems: [] };

  let productCount;
  if (rules.maxProducts > 0) {
    productCount = await db.productSubmission.count({
      where: {
        vendorId,
        status: { in: ["DRAFT", "PENDING", "APPROVED"] },
        ...(submissionId ? { id: { not: submissionId } } : {}),
      },
    });
  }

  return { problems: breaksRules(rules, product, { productCount }) };
}

export async function updateListingRules(shop, input) {
  const whole = (value, max) => {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) && number > 0 ? Math.min(number, max) : 0;
  };

  const words = String(input.bannedWords ?? "")
    .split(/[\n,]/)
    .map((word) => word.trim())
    .filter(Boolean)
    .slice(0, RULE_LIMITS.words);

  await db.shopSettings.upsert({
    where: { shop },
    update: {
      minProductImages: whole(input.minImages, RULE_LIMITS.images),
      requireDescription: Boolean(input.requireDescription),
      requireProductType: Boolean(input.requireProductType),
      bannedWords: words,
      maxProductsPerVendor: whole(input.maxProducts, RULE_LIMITS.products),
    },
    create: { shop },
  });

  return { saved: true };
}
