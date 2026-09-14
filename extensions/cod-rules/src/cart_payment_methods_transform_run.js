// @ts-check

/**
 * @typedef {import("../generated/api").CartPaymentMethodsTransformRunInput} CartPaymentMethodsTransformRunInput
 * @typedef {import("../generated/api").CartPaymentMethodsTransformRunResult} CartPaymentMethodsTransformRunResult
 */

/**
 * Written by the StoreVendor app. Only vendors with a COD restriction are listed:
 * `{ codEnabled: false }` or `{ codEnabled: true, maxOrderValue }` in the shop currency.
 * @typedef {{ codEnabled: boolean, maxOrderValue?: number }} VendorCodRule
 * @typedef {{ vendors?: Record<string, VendorCodRule> }} Configuration
 */

/**
 * @type {CartPaymentMethodsTransformRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

// Shopify's manual payment method is named "Cash on Delivery (COD)"; merchants can rename it.
const CASH_ON_DELIVERY = /cash\s*on\s*delivery|\bcod\b/i;

/**
 * Hides cash on delivery when the cart has a product from a vendor that doesn't offer it,
 * or when the order total is above a vendor's COD limit.
 * @param {CartPaymentMethodsTransformRunInput} input
 * @returns {CartPaymentMethodsTransformRunResult}
 */
export function cartPaymentMethodsTransformRun(input) {
  /** @type {Configuration} */
  const configuration = input.paymentCustomization?.metafield?.jsonValue ?? {};
  const vendors = configuration.vendors ?? {};

  // Limits are in the shop currency; the cart total is in the buyer's currency.
  const rate = Number(input.presentmentCurrencyRate) || 1;
  const totalInShopCurrency = Number(input.cart.cost.totalAmount.amount) / rate;

  const codNotAllowed = input.cart.lines.some((line) => {
    if (line.merchandise.__typename !== "ProductVariant") return false;

    const vendorId = line.merchandise.product.vendorId?.value;
    const rule = vendorId ? vendors[vendorId] : undefined;
    if (!rule) return false;
    if (!rule.codEnabled) return true;

    return typeof rule.maxOrderValue === "number" && totalInShopCurrency > rule.maxOrderValue;
  });

  if (!codNotAllowed) return NO_CHANGES;

  return {
    operations: input.paymentMethods
      .filter((method) => CASH_ON_DELIVERY.test(method.name))
      .map((method) => ({ paymentMethodHide: { paymentMethodId: method.id } })),
  };
}
