import { useEffect } from "react";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { addCarrier, approveCarrier, carrierChoices, listCarrierRequests, rejectCarrier } from "../models/carrier.server";
import { getCollectionSyncStatus, syncCollections } from "../models/collection.server";
import {
  connectLabelAccount,
  disconnectLabelAccount,
  LABEL_PROVIDERS,
} from "../models/label-account.server";
import {
  getShopCurrency,
  getShopSettings,
  shopLocations,
  updateDefaultCommission,
  updateFulfillmentDays,
  ratesToText,
  updateInvoiceSettings,
  updatePayoutFx,
  updatePayoutSettings,
  updateRestockLocation,
  updateTaxReporting,
} from "../models/settings.server";
import { ratesAreStale, ratesMatchCurrency } from "../models/fx.server";
import { SELLER_PLACEHOLDER } from "../models/invoice.server";
import { connectPaypal, connectStripe, disconnectRail } from "../models/payout-rails.server";
import { PAYPAL_CURRENCIES } from "../models/payout-rails/paypal.server";
import db from "../db.server";
import { formatDate, formatDateTime } from "../utils/vendor-display";

const ACTOR = "merchant";

// A line of today's rates, so the merchant can see at a glance whether they look right
// without reading 160 of them.
function sampleRates(rates, shopCurrency) {
  const shown = ["USD", "EUR", "GBP", "INR", "AED"]
    .filter((code) => code !== shopCurrency && rates?.[code])
    .slice(0, 3)
    .map((code) => `${Number(rates[code]).toPrecision(4)} ${code}`);
  return shown.length ? `Right now 1 ${shopCurrency} buys ${shown.join(", ")}.` : "";
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const [settings, currencyCode, collections, carriers, choices, locations] = await Promise.all([
    getShopSettings(session.shop),
    getShopCurrency(admin),
    getCollectionSyncStatus(session.shop),
    listCarrierRequests(session.shop),
    carrierChoices(session.shop),
    shopLocations(admin),
  ]);

  return {
    currencyCode,
    locations: locations.map((location) => ({ id: location.id, name: location.name })),
    restockLocationId: settings.restockLocationId ?? "",
    carriers: {
      fromShopify: choices.fromShopify.length,
      requests: carriers.map((carrier) => ({
        id: carrier.id,
        name: carrier.name,
        status: carrier.status,
        reason: carrier.reason,
        reviewNote: carrier.reviewNote,
        trackingUrlTemplate: carrier.trackingUrlTemplate,
        requestedAt: formatDate(carrier.createdAt),
      })),
    },
    commission: {
      percent: String(settings.commissionPercent),
      fixed: String(settings.commissionFixed),
    },
    fulfillmentDays: settings.fulfillmentDays,
    payouts: {
      holdValue: String(settings.payoutHoldValue),
      holdUnit: settings.payoutHoldUnit,
      minimum: String(settings.payoutMinimum),
      minimumEnabled: settings.payoutMinimumEnabled,
      changeHoldEnabled: settings.payoutChangeHoldEnabled,
      changeHoldHours: String(settings.payoutChangeHoldHours),
      requests: settings.payoutRequests,
      schedule: settings.payoutSchedule,
      refundKeepsCommission: settings.refundKeepsCommission,
    },
    // Labels only: the credentials themselves never leave the server.
    rails: {
      paypal: settings.paypalAccount ?? null,
      stripe: settings.stripeAccount ?? null,
      autoSend: settings.autoSendPayouts,
      // Only worth warning about when the store's own currency can't go through PayPal.
      currencyUnsupported: !PAYPAL_CURRENCIES.has(settings.currencyCode ?? currencyCode),
    },
    payoutFx: {
      enabled: settings.payoutFxEnabled,
      auto: settings.payoutFxAuto,
      rates: ratesToText(settings.payoutFxRates),
      count: Object.keys(settings.payoutFxRates ?? {}).length,
      // "155 currencies · 23 Sep 2026, 00:02 · exchangerate-api.com", skipping whichever
      // parts a store that's had rates typed in by hand doesn't have.
      status: [
        `${Object.keys(settings.payoutFxRates ?? {}).length} currencies`,
        settings.payoutFxRatesAt ? formatDateTime(settings.payoutFxRatesAt) : "not updated yet",
        settings.payoutFxSource && settings.payoutFxSource !== "you" ? settings.payoutFxSource : null,
      ]
        .filter(Boolean)
        .join(" · "),
      base: settings.payoutFxBase,
      stale: ratesAreStale(settings),
      currencyChanged: !ratesMatchCurrency(settings, settings.currencyCode ?? currencyCode),
      sample: sampleRates(settings.payoutFxRates, settings.currencyCode ?? currencyCode),
    },
    taxReporting: {
      us1099kAmount: String(settings.us1099kAmount),
      us1099kTransactions: String(settings.us1099kTransactions),
      dac7MinTransactions: String(settings.dac7MinTransactions),
      dac7MinAmount: String(settings.dac7MinAmount),
    },
    invoices: {
      businessName: settings.businessName ?? "",
      businessAddress: settings.businessAddress ?? "",
      businessTaxId: settings.businessTaxId ?? "",
      taxLabel: settings.taxLabel,
      taxRate: String(settings.commissionTaxRate),
      prefix: settings.invoicePrefix,
      autoInvoices: settings.autoInvoices,
      placeholder: SELLER_PLACEHOLDER,
    },
    // Nothing to configure: this only shows the merchant how vendors will see their mail.
    email: {
      sender: settings.businessName || settings.shopName || session.shop.replace(/\.myshopify\.com$/, ""),
      replyTo: settings.shopEmail ?? null,
    },
    // The key itself never leaves the server; only whether one is connected.
    labels: {
      provider: settings.labelProvider ?? "",
      account: settings.labelAccount ?? null,
      providers: Object.entries(LABEL_PROVIDERS).map(([value, provider]) => ({
        value,
        label: provider.label,
      })),
    },
    collections: {
      count: collections.count,
      syncedAt: collections.syncedAt ? formatDate(collections.syncedAt) : null,
    },
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "approveCarrier") {
    const result = await approveCarrier(session.shop, String(formData.get("carrierId") ?? ""), ACTOR);
    return { intent, error: result.error ?? null };
  }

  if (intent === "rejectCarrier") {
    const result = await rejectCarrier(
      session.shop,
      String(formData.get("carrierId") ?? ""),
      String(formData.get("note") ?? ""),
      ACTOR,
    );
    return { intent, error: result.error ?? null };
  }

  if (intent === "addCarrier") {
    const result = await addCarrier(session.shop, {
      name: String(formData.get("carrierName") ?? ""),
      trackingUrlTemplate: String(formData.get("trackingUrlTemplate") ?? ""),
    });
    return { intent, error: result.error ?? null };
  }

  if (intent === "payouts") {
    const result = await updatePayoutSettings(session.shop, {
      holdValue: formData.get("holdValue"),
      holdUnit: String(formData.get("holdUnit") ?? ""),
      minimum: formData.get("minimum"),
      minimumEnabled: formData.get("minimumEnabled") === "on",
      requests: formData.get("requests") === "on",
      schedule: String(formData.get("schedule") ?? ""),
      refundKeepsCommission: formData.get("refundKeepsCommission") === "on",
      changeHoldEnabled: formData.get("changeHoldEnabled") === "on",
      changeHoldHours: formData.get("changeHoldHours"),
    });
    return { intent, errors: result.errors ?? null, saved: Boolean(result.saved) };
  }

  if (intent === "connectPaypal") {
    const result = await connectPaypal(session.shop, {
      clientId: String(formData.get("clientId") ?? ""),
      secret: String(formData.get("secret") ?? ""),
      mode: String(formData.get("mode") ?? ""),
    });
    return { intent, error: result.error ?? null, errors: result.errors ?? null, saved: Boolean(result.ok) };
  }

  if (intent === "connectStripe") {
    const result = await connectStripe(session.shop, { secretKey: String(formData.get("secretKey") ?? "") });
    return { intent, error: result.error ?? null, errors: result.errors ?? null, saved: Boolean(result.ok) };
  }

  if (intent === "disconnectRail") {
    await disconnectRail(session.shop, String(formData.get("rail") ?? ""));
    return { intent, error: null, saved: true };
  }

  if (intent === "autoSend") {
    await db.shopSettings.upsert({
      where: { shop: session.shop },
      update: { autoSendPayouts: formData.get("autoSend") === "on" },
      create: { shop: session.shop, autoSendPayouts: formData.get("autoSend") === "on" },
    });
    return { intent, error: null, saved: true };
  }

  // The same save either way; the second form only flips between daily rates and your own.
  if (intent === "payoutFx" || intent === "payoutFxMode") {
    const result = await updatePayoutFx(session.shop, {
      enabled: formData.get("enabled") === "on",
      auto: formData.get("auto") === "on",
      ratesText: formData.get("rates"),
    });
    return {
      intent,
      errors: result.errors ?? null,
      saved: Boolean(result.saved),
      refreshError: result.refreshError ?? null,
    };
  }

  if (intent === "taxReporting") {
    const result = await updateTaxReporting(session.shop, {
      us1099kAmount: formData.get("us1099kAmount"),
      us1099kTransactions: formData.get("us1099kTransactions"),
      dac7MinTransactions: formData.get("dac7MinTransactions"),
      dac7MinAmount: formData.get("dac7MinAmount"),
    });
    return { intent, errors: result.errors ?? null, saved: Boolean(result.saved) };
  }

  if (intent === "invoices") {
    const result = await updateInvoiceSettings(session.shop, {
      businessName: formData.get("businessName"),
      businessAddress: formData.get("businessAddress"),
      businessTaxId: formData.get("businessTaxId"),
      taxLabel: formData.get("taxLabel"),
      taxRate: formData.get("taxRate"),
      prefix: formData.get("prefix"),
      autoInvoices: formData.get("autoInvoices") === "on",
    });
    return { intent, errors: result.errors ?? null, saved: Boolean(result.saved) };
  }

  if (intent === "connectLabels") {
    const result = await connectLabelAccount(
      session.shop,
      String(formData.get("provider") ?? ""),
      String(formData.get("apiKey") ?? ""),
    );
    return { intent, error: result.error ?? null, saved: Boolean(result.account) };
  }

  if (intent === "disconnectLabels") {
    await disconnectLabelAccount(session.shop);
    return { intent, error: null, saved: true };
  }

  if (intent === "restockLocation") {
    const result = await updateRestockLocation(
      session.shop,
      String(formData.get("locationId") ?? ""),
      await shopLocations(admin),
    );
    return { intent, error: result.error ?? null, saved: !result.error };
  }

  if (intent === "fulfillmentDays") {
    const result = await updateFulfillmentDays(session.shop, formData.get("days"));
    return { intent, error: result.error ?? null, saved: Boolean(result.days) };
  }

  if (intent === "syncCollections") {
    try {
      const count = await syncCollections(admin, session.shop);
      return { intent, synced: count };
    } catch (error) {
      console.error("Collection sync failed", error);
      return { intent, syncError: "Collections couldn't be synced. Try again." };
    }
  }

  const values = {
    percent: String(formData.get("percent") ?? ""),
    fixed: String(formData.get("fixed") ?? ""),
  };

  const result = await updateDefaultCommission(session.shop, values);
  if (result.errors) return { intent: "commission", errors: result.errors, values };

  return { intent: "commission", saved: true };
};

const CARRIER_INTENTS = ["approveCarrier", "rejectCarrier", "addCarrier"];

const CARRIER_STATUS = {
  PENDING: { label: "Waiting for you", tone: "warning" },
  APPROVED: { label: "Available", tone: "success" },
  REJECTED: { label: "Rejected", tone: "critical" },
};

export default function Settings() {
  const {
    commission,
    currencyCode,
    collections,
    carriers,
    fulfillmentDays,
    locations,
    restockLocationId,
    labels,
    payouts,
    email,
    invoices,
    taxReporting,
    payoutFx,
    rails,
  } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  // Field errors belong to whichever form was submitted, so each section only reads its own.
  const errorsFor = (...intents) =>
    intents.includes(actionData?.intent) ? (actionData.errors ?? {}) : {};
  const railErrors = errorsFor("connectPaypal", "connectStripe");
  const fxErrors = errorsFor("payoutFx", "payoutFxMode");
  const taxErrors = errorsFor("taxReporting");
  const invoiceErrors = errorsFor("invoices");
  const submittingIntent =
    navigation.state === "submitting" ? navigation.formData?.get("intent") : null;
  const errors = actionData?.intent === "commission" ? (actionData.errors ?? {}) : {};
  const values = (actionData?.intent === "commission" && actionData.values) || commission;

  useEffect(() => {
    if (actionData?.saved) shopify.toast.show("Settings saved");
    if (typeof actionData?.synced === "number") {
      shopify.toast.show(
        `${actionData.synced} ${actionData.synced === 1 ? "collection" : "collections"} synced`,
      );
    }
  }, [actionData, shopify]);

  return (
    <s-page heading="Settings" inlineSize="small">
      <s-section heading="Default commission">
        <Form method="post">
          <input type="hidden" name="intent" value="commission" />
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              What you keep from each vendor sale, unless a vendor has a custom
              commission. It&apos;s a percentage of the item price plus an
              optional fixed amount per item.
            </s-paragraph>
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-number-field
                label="Percentage"
                name="percent"
                suffix="%"
                inputMode="decimal"
                step={0.01}
                min={0}
                max={100}
                defaultValue={values.percent}
                error={errors.percent}
                required
              ></s-number-field>
              <s-number-field
                label="Fixed amount per item"
                name="fixed"
                suffix={currencyCode}
                inputMode="decimal"
                step={0.01}
                min={0}
                defaultValue={values.fixed}
                error={errors.fixed}
              ></s-number-field>
            </s-grid>
            <s-stack direction="inline">
              <s-button
                type="submit"
                variant="primary"
                loading={submittingIntent === "commission"}
              >
                Save
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Vendor payouts">
        <Form method="post">
          <input type="hidden" name="intent" value="payouts" />
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              A vendor&apos;s share becomes available once the order is both paid and shipped, plus the
              hold below. The hold covers your own payout from Shopify and the returns window, so you
              never pay out money you haven&apos;t received or might have to refund.
            </s-paragraph>
            <s-grid gridTemplateColumns="minmax(0,9rem) minmax(0,11rem) minmax(0,1fr)" gap="base">
              <s-number-field
                label="Hold for"
                name="holdValue"
                inputMode="numeric"
                step={1}
                min={0}
                defaultValue={payouts.holdValue}
                error={actionData?.intent === "payouts" ? actionData.errors?.holdValue : undefined}
                required
              ></s-number-field>
              <s-select
                label="&nbsp;"
                name="holdUnit"
                value={payouts.holdUnit}
                error={actionData?.intent === "payouts" ? actionData.errors?.holdUnit : undefined}
              >
                <s-option value="DAYS">days</s-option>
                <s-option value="WEEKS">weeks</s-option>
                <s-option value="MONTHS">months</s-option>
              </s-select>
              <s-number-field
                label="Smallest payout"
                name="minimum"
                suffix={currencyCode}
                inputMode="decimal"
                step={0.01}
                min={0}
                defaultValue={payouts.minimum}
                error={actionData?.intent === "payouts" ? actionData.errors?.minimum : undefined}
              ></s-number-field>
            </s-grid>
            <s-checkbox
              label="Only pay out once a vendor reaches the smallest payout"
              name="minimumEnabled"
              defaultChecked={payouts.minimumEnabled}
              details="Off: any balance can be paid out, however small."
            ></s-checkbox>
            <s-grid gridTemplateColumns="minmax(0,20rem)" gap="base">
              <s-number-field
                label="Pause payouts after payout details change"
                name="changeHoldHours"
                suffix="hours"
                inputMode="numeric"
                min={1}
                max={720}
                defaultValue={payouts.changeHoldHours}
                details="If someone else changed where a vendor's money goes, this is the window to notice before any of it is sent."
                error={actionData?.intent === "payouts" ? actionData.errors?.changeHoldHours : undefined}
              ></s-number-field>
            </s-grid>
            <s-checkbox
              label="Pause payouts for a while after you approve a payout change"
              name="changeHoldEnabled"
              defaultChecked={payouts.changeHoldEnabled}
              details="Off: a vendor can be paid to new details the moment you approve them."
            ></s-checkbox>
            <s-grid gridTemplateColumns="minmax(0,20rem)" gap="base">
              <s-select
                label="Set payouts aside"
                name="schedule"
                value={payouts.schedule}
                details="Everyone due goes onto your To send list, and straight out if PayPal or Stripe is connected and set to send automatically. Checked once a night."
              >
                <s-option value="MANUAL">When I click Pay</s-option>
                <s-option value="DAILY">As soon as a vendor reaches the smallest payout</s-option>
                <s-option value="WEEKLY">Every Monday</s-option>
                <s-option value="MONTHLY">On the 1st of each month</s-option>
              </s-select>
            </s-grid>
            <s-checkbox
              label="Vendors can ask for their available balance"
              name="requests"
              defaultChecked={payouts.requests}
              details="You still accept or decline each request."
            ></s-checkbox>
            <s-checkbox
              label="Keep my commission when an order is refunded"
              name="refundKeepsCommission"
              defaultChecked={payouts.refundKeepsCommission}
              details="Off: a refund takes back your commission on those items as well as the vendor's share. On: the vendor carries the whole refund. Applies to orders placed from now on."
            ></s-checkbox>
            <s-stack direction="inline">
              <s-button type="submit" loading={submittingIntent === "payouts"}>
                Save
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Shipping deadline">
        <Form method="post">
          <input type="hidden" name="intent" value="fulfillmentDays" />
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              How long a vendor has to ship an order. After that it&apos;s marked overdue for you
              and for them, so it can be chased before the customer starts asking.
            </s-paragraph>
            {actionData?.intent === "fulfillmentDays" && actionData.error && (
              <s-banner tone="critical">{actionData.error}</s-banner>
            )}
            <s-grid gridTemplateColumns="minmax(0,14rem)" gap="base">
              <s-number-field
                label="Ship within"
                name="days"
                suffix="days"
                inputMode="numeric"
                step={1}
                min={1}
                max={60}
                defaultValue={String(fulfillmentDays)}
                required
              ></s-number-field>
            </s-grid>
            <s-stack direction="inline">
              <s-button type="submit" loading={submittingIntent === "fulfillmentDays"}>
                Save
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Returns">
        <Form method="post">
          <input type="hidden" name="intent" value="restockLocation" />
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              Vendors can approve or turn down returns of their own items, and put returned stock
              back once it reaches them. Pick where that stock lands; until you do, they can&apos;t
              restock. Refunds stay with you.
            </s-paragraph>
            {actionData?.intent === "restockLocation" && actionData.error && (
              <s-banner tone="critical">{actionData.error}</s-banner>
            )}
            <s-grid gridTemplateColumns="minmax(0,20rem) auto" gap="base" alignItems="end">
              <s-select label="Restock returns to" name="locationId" value={restockLocationId}>
                <s-option value="">Don&apos;t let vendors restock</s-option>
                {locations.map((location) => (
                  <s-option key={location.id} value={location.id}>
                    {location.name}
                  </s-option>
                ))}
              </s-select>
              <s-button type="submit" loading={submittingIntent === "restockLocation"}>
                Save
              </s-button>
            </s-grid>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Collections for vendors">
        <Form method="post">
          <input type="hidden" name="intent" value="syncCollections" />
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              Vendors can add their products to your manual collections. Smart
              collections pick up products automatically by their conditions.
              Changes in Shopify sync automatically.
            </s-paragraph>
            {actionData?.syncError && (
              <s-banner tone="critical">{actionData.syncError}</s-banner>
            )}
            <s-text>
              {collections.syncedAt
                ? `${collections.count} manual ${collections.count === 1 ? "collection" : "collections"} · last full sync ${collections.syncedAt}`
                : "Not synced yet"}
            </s-text>
            <s-stack direction="inline">
              <s-button type="submit" loading={submittingIntent === "syncCollections"}>
                Sync now
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Automatic payouts">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Send payouts from your own PayPal or Stripe account instead of by hand. Vendors paid by
            PayPal get it at their PayPal email; vendors who connect Stripe from the portal get a
            transfer to their Stripe account. Try both with sandbox or test credentials first.
          </s-paragraph>
          {["connectPaypal", "connectStripe"].includes(actionData?.intent) && actionData.error && (
            <s-banner tone="critical">{actionData.error}</s-banner>
          )}
          {rails.currencyUnsupported && (
            <s-banner tone="info">
              {`PayPal can't send ${currencyCode}, and Stripe may not hold it either. From a ${currencyCode} store these rails only work with currency conversion on, below, and vendors choosing a currency the rail supports, like USD.`}
            </s-banner>
          )}

          <s-stack direction="block" gap="small">
            <s-text type="strong">PayPal</s-text>
            {rails.paypal ? (
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-badge tone="success">Connected</s-badge>
                <s-text color="subdued">{rails.paypal}</s-text>
                <Form method="post">
                  <input type="hidden" name="intent" value="disconnectRail" />
                  <input type="hidden" name="rail" value="PAYPAL" />
                  <s-button type="submit" variant="tertiary" tone="critical">
                    Disconnect
                  </s-button>
                </Form>
              </s-stack>
            ) : (
              <Form method="post">
                <input type="hidden" name="intent" value="connectPaypal" />
                <s-stack direction="block" gap="base">
                  <s-grid gridTemplateColumns="minmax(0,10rem) minmax(0,1fr) minmax(0,1fr)" gap="base">
                    <s-select label="Mode" name="mode" value="sandbox">
                      <s-option value="sandbox">Sandbox</s-option>
                      <s-option value="live">Live</s-option>
                    </s-select>
                    <s-text-field label="Client ID" name="clientId" error={railErrors.clientId}></s-text-field>
                    <s-password-field
                      label="Secret"
                      name="secret"
                      autocomplete="off"
                      error={railErrors.secret}
                    ></s-password-field>
                  </s-grid>
                  <s-stack direction="inline">
                    <s-button type="submit" loading={submittingIntent === "connectPaypal"}>
                      Connect PayPal
                    </s-button>
                  </s-stack>
                </s-stack>
              </Form>
            )}
          </s-stack>

          <s-divider></s-divider>

          <s-stack direction="block" gap="small">
            <s-text type="strong">Stripe</s-text>
            {rails.stripe ? (
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-badge tone="success">Connected</s-badge>
                <s-text color="subdued">{rails.stripe}</s-text>
                <Form method="post">
                  <input type="hidden" name="intent" value="disconnectRail" />
                  <input type="hidden" name="rail" value="STRIPE" />
                  <s-button type="submit" variant="tertiary" tone="critical">
                    Disconnect
                  </s-button>
                </Form>
              </s-stack>
            ) : (
              <Form method="post">
                <input type="hidden" name="intent" value="connectStripe" />
                <s-grid gridTemplateColumns="minmax(0,1fr) auto" gap="base" alignItems="end">
                  <s-password-field
                    label="Secret key"
                    name="secretKey"
                    autocomplete="off"
                    placeholder="sk_test_…"
                    details="Needs Stripe Connect switched on in your Stripe dashboard."
                    error={railErrors.secretKey}
                  ></s-password-field>
                  <s-button type="submit" loading={submittingIntent === "connectStripe"}>
                    Connect Stripe
                  </s-button>
                </s-grid>
              </Form>
            )}
          </s-stack>

          <s-divider></s-divider>

          <Form method="post">
            <input type="hidden" name="intent" value="autoSend" />
            <s-stack direction="block" gap="small">
              <s-checkbox
                label="Send through PayPal or Stripe as soon as a payout is set aside"
                name="autoSend"
                defaultChecked={rails.autoSend}
                details="Off: you press Send on each one. Anything a rail can't send waits for you either way."
              ></s-checkbox>
              <s-stack direction="inline">
                <s-button type="submit" loading={submittingIntent === "autoSend"}>
                  Save
                </s-button>
              </s-stack>
            </s-stack>
          </Form>
        </s-stack>
      </s-section>

      <s-section heading="Paying vendors in other currencies">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            {`Vendors can ask to be paid in their own currency. What they're owed stays in ${currencyCode}; each payout is converted when it's set aside, and the rate used is kept on the payout. Your bank's rate on the day is what actually counts.`}
          </s-paragraph>

          {["payoutFx", "payoutFxMode"].includes(actionData?.intent) && actionData.refreshError && (
            <s-banner tone="warning">
              {`Rates couldn't be updated: ${actionData.refreshError}. The ones already saved are still being used.`}
            </s-banner>
          )}
          {payoutFx.currencyChanged && (
            <s-banner tone="warning">
              {`These rates were fetched for ${payoutFx.base}, but the store is now in ${currencyCode}. Update them before converting any more payouts.`}
            </s-banner>
          )}
          {payoutFx.stale && !payoutFx.currencyChanged && (
            <s-banner tone="warning">
              {payoutFx.auto
                ? "Rates haven't updated in the last couple of days. Update them now, or check back later."
                : "These rates are a few days old. Check them against your bank's."}
            </s-banner>
          )}

          <Form method="post">
            <input type="hidden" name="intent" value="payoutFx" />
            <input type="hidden" name="auto" value={payoutFx.auto ? "on" : "off"} />
            <s-stack direction="block" gap="base">
              <s-checkbox
                label="Convert payouts for vendors who asked for another currency"
                name="enabled"
                defaultChecked={payoutFx.enabled}
                details="Off: everyone is paid in your currency, whatever they asked for."
              ></s-checkbox>

              {payoutFx.auto ? (
                <s-box padding="base" background="subdued" borderRadius="base">
                  <s-stack direction="block" gap="small">
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-badge tone={payoutFx.stale ? "warning" : "success"}>Updated daily</s-badge>
                      <s-text color="subdued">
                        {payoutFx.count ? payoutFx.status : "No rates yet — save to fetch today's."}
                      </s-text>
                    </s-stack>
                    <s-paragraph color="subdued">
                      {`Today's rates for 1 ${currencyCode} are fetched for you, so a vendor can ask for any currency and be paid in it. ${payoutFx.sample || ""}`}
                    </s-paragraph>
                  </s-stack>
                </s-box>
              ) : (
                <s-text-area
                  label={`Rates for 1 ${currencyCode}`}
                  name="rates"
                  rows={5}
                  defaultValue={payoutFx.rates}
                  placeholder="USD = 0.0082"
                  details="One per line: a currency code, then how much of it one unit of your currency buys."
                  error={fxErrors.rates}
                ></s-text-area>
              )}

              <s-stack direction="inline" gap="base">
                <s-button type="submit" loading={submittingIntent === "payoutFx"}>
                  {payoutFx.auto && payoutFx.count ? "Save and update rates" : "Save"}
                </s-button>
              </s-stack>
            </s-stack>
          </Form>

          <Form method="post">
            <input type="hidden" name="intent" value="payoutFxMode" />
            <input type="hidden" name="enabled" value={payoutFx.enabled ? "on" : "off"} />
            <input type="hidden" name="auto" value={payoutFx.auto ? "off" : "on"} />
            <input type="hidden" name="rates" value={payoutFx.rates} />
            <s-stack direction="inline">
              <s-button type="submit" variant="tertiary" loading={submittingIntent === "payoutFxMode"}>
                {payoutFx.auto ? "Set the rates myself instead" : "Go back to daily rates"}
              </s-button>
            </s-stack>
          </Form>
        </s-stack>
      </s-section>

      <s-section heading="Commission invoices">
        <Form method="post">
          <input type="hidden" name="intent" value="invoices" />
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              Each month vendors get an invoice for the commission you took, numbered in sequence.
              Anything left blank prints as a placeholder, and invoices never change once issued, so
              fill these in before real invoices go out.
            </s-paragraph>
            <s-grid gridTemplateColumns="minmax(0,1fr) minmax(0,1fr)" gap="base">
              <s-text-field
                label="Legal business name"
                name="businessName"
                defaultValue={invoices.businessName}
                placeholder={invoices.placeholder.name}
              ></s-text-field>
              <s-text-field
                label="Tax number"
                name="businessTaxId"
                defaultValue={invoices.businessTaxId}
                placeholder={invoices.placeholder.taxId}
                details="VAT, GST, BIN or TIN, as it appears on your registration."
              ></s-text-field>
            </s-grid>
            <s-text-area
              label="Business address"
              name="businessAddress"
              rows={2}
              defaultValue={invoices.businessAddress}
              placeholder={invoices.placeholder.address}
            ></s-text-area>
            <s-grid gridTemplateColumns="minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)" gap="base">
              <s-text-field
                label="Tax is called"
                name="taxLabel"
                defaultValue={invoices.taxLabel}
                placeholder="VAT"
              ></s-text-field>
              <s-number-field
                label="Tax on commission"
                name="taxRate"
                suffix="%"
                inputMode="decimal"
                step={0.01}
                min={0}
                max={100}
                defaultValue={invoices.taxRate}
                details="0 where commission isn't taxed."
                error={invoiceErrors.taxRate}
              ></s-number-field>
              <s-text-field
                label="Invoice numbers start with"
                name="prefix"
                defaultValue={invoices.prefix}
                error={invoiceErrors.prefix}
              ></s-text-field>
            </s-grid>
            <s-checkbox
              label="Issue last month's invoices automatically on the 1st"
              name="autoInvoices"
              defaultChecked={invoices.autoInvoices}
            ></s-checkbox>
            <s-stack direction="inline">
              <s-button type="submit" loading={submittingIntent === "invoices"}>
                Save
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Tax reporting">
        <Form method="post">
          <input type="hidden" name="intent" value="taxReporting" />
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              As the marketplace operator you report vendors&apos; sales: 1099-K for vendors in the US,
              DAC7 for vendors in the EU. Vendors add their tax details in the portal, and the reports
              under Payouts flag anyone missing something. These limits change with the law, so check
              them before you file.
            </s-paragraph>
            <s-grid gridTemplateColumns="minmax(0,1fr) minmax(0,1fr)" gap="base">
              <s-number-field
                label="1099-K: report from"
                name="us1099kAmount"
                suffix={currencyCode}
                inputMode="decimal"
                min={0}
                defaultValue={taxReporting.us1099kAmount}
                error={taxErrors.us1099kAmount}
              ></s-number-field>
              <s-number-field
                label="1099-K: and at least"
                name="us1099kTransactions"
                suffix="sales"
                inputMode="numeric"
                min={0}
                defaultValue={taxReporting.us1099kTransactions}
                error={taxErrors.us1099kTransactions}
              ></s-number-field>
              <s-number-field
                label="DAC7: exempt below"
                name="dac7MinTransactions"
                suffix="sales"
                inputMode="numeric"
                min={0}
                defaultValue={taxReporting.dac7MinTransactions}
                error={taxErrors.dac7MinTransactions}
              ></s-number-field>
              <s-number-field
                label="DAC7: and below"
                name="dac7MinAmount"
                suffix={currencyCode}
                inputMode="decimal"
                min={0}
                defaultValue={taxReporting.dac7MinAmount}
                details="The EU limit is €2,000; set its equivalent in your currency."
                error={taxErrors.dac7MinAmount}
              ></s-number-field>
            </s-grid>
            <s-stack direction="inline">
              <s-button type="submit" loading={submittingIntent === "taxReporting"}>
                Save
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Vendor emails">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Vendors are emailed when their money moves. StoreVendor sends these for you, so there
            {"'"}s nothing to set up: they go out as <s-text type="strong">{email.sender}</s-text>,
            and replies come back to {email.replyTo ? email.replyTo : "your store's contact address"}.
          </s-paragraph>
          <s-stack direction="inline">
            <s-button variant="secondary" href="/app/emails">
              Email log
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Shipping labels">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Connect your own Shippo or EasyPost account and vendors will be able to buy labels for
            their parcels. You&apos;re billed by the carrier, not by us, and the key is encrypted
            before it&apos;s stored.
          </s-paragraph>
          {actionData?.intent === "connectLabels" && actionData.error && (
            <s-banner tone="critical">{actionData.error}</s-banner>
          )}

          {labels.account ? (
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-badge tone="success">Connected</s-badge>
                <s-text>{labels.account}</s-text>
              </s-stack>
              <Form method="post">
                <input type="hidden" name="intent" value="disconnectLabels" />
                <s-stack direction="inline">
                  <s-button type="submit" tone="critical" loading={submittingIntent === "disconnectLabels"}>
                    Disconnect
                  </s-button>
                </s-stack>
              </Form>
            </s-stack>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="connectLabels" />
              <s-stack direction="block" gap="base">
                <s-grid gridTemplateColumns="minmax(0,14rem) minmax(0,1fr)" gap="base">
                  <s-select label="Provider" name="provider" value="shippo">
                    {labels.providers.map((provider) => (
                      <s-option key={provider.value} value={provider.value}>
                        {provider.label}
                      </s-option>
                    ))}
                  </s-select>
                  <s-password-field
                    label="API key"
                    name="apiKey"
                    autocomplete="off"
                    details="Checked with the provider before it's saved."
                    required
                  ></s-password-field>
                </s-grid>
                <s-stack direction="inline">
                  <s-button type="submit" loading={submittingIntent === "connectLabels"}>
                    Connect
                  </s-button>
                </s-stack>
              </s-stack>
            </Form>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Couriers vendors can use">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            {`Vendors pick from ${carriers.fromShopify} couriers Shopify recognises in your country, so tracking links work by themselves. If their courier isn't there, they ask you to add it.`}
          </s-paragraph>

          {CARRIER_INTENTS.includes(actionData?.intent) && actionData.error && (
            <s-banner tone="critical">{actionData.error}</s-banner>
          )}

          {carriers.requests.length > 0 && (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Courier</s-table-header>
                <s-table-header listSlot="secondary">Why</s-table-header>
                <s-table-header listSlot="labeled">Status</s-table-header>
                <s-table-header listSlot="labeled">Action</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {carriers.requests.map((carrier) => (
                  <s-table-row key={carrier.id}>
                    <s-table-cell>
                      <s-stack direction="block">
                        <s-text>{carrier.name}</s-text>
                        {carrier.trackingUrlTemplate && (
                          <s-text color="subdued">{carrier.trackingUrlTemplate}</s-text>
                        )}
                      </s-stack>
                    </s-table-cell>
                    <s-table-cell>{carrier.reason ?? "Added by you"}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={CARRIER_STATUS[carrier.status].tone}>
                        {CARRIER_STATUS[carrier.status].label}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      {carrier.status === "PENDING" ? (
                        <s-stack direction="inline" gap="small">
                          <Form method="post">
                            <input type="hidden" name="intent" value="approveCarrier" />
                            <input type="hidden" name="carrierId" value={carrier.id} />
                            <s-button type="submit" variant="primary">
                              Approve
                            </s-button>
                          </Form>
                          <Form method="post">
                            <input type="hidden" name="intent" value="rejectCarrier" />
                            <input type="hidden" name="carrierId" value={carrier.id} />
                            <input type="hidden" name="note" value="Not a courier this store works with." />
                            <s-button type="submit">Reject</s-button>
                          </Form>
                        </s-stack>
                      ) : (
                        <s-text color="subdued">{carrier.requestedAt ?? "—"}</s-text>
                      )}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}

          <s-divider></s-divider>

          <Form method="post">
            <input type="hidden" name="intent" value="addCarrier" />
            <s-stack direction="block" gap="base">
              <s-heading>Add a courier</s-heading>
              <s-grid gridTemplateColumns="minmax(0,1fr) minmax(0,1fr)" gap="base">
                <s-text-field label="Name" name="carrierName" placeholder="Pathao" required></s-text-field>
                <s-text-field
                  label="Tracking link"
                  name="trackingUrlTemplate"
                  placeholder="https://courier.com/track?id={tracking_number}"
                  details="Optional. {tracking_number} is replaced with the number."
                ></s-text-field>
              </s-grid>
              <s-stack direction="inline">
                <s-button type="submit" loading={submittingIntent === "addCarrier"}>
                  Add courier
                </s-button>
              </s-stack>
            </s-stack>
          </Form>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
