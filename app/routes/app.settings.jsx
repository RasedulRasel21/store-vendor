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
  connectEmail,
  disconnectEmail,
  EMAIL_PROVIDERS,
  PLACEHOLDER_FROM,
  sendEmail,
} from "../models/email.server";
import {
  getShopCurrency,
  getShopSettings,
  shopLocations,
  updateDefaultCommission,
  updateFulfillmentDays,
  updateInvoiceSettings,
  updatePayoutSettings,
  updateRestockLocation,
  updateTaxReporting,
} from "../models/settings.server";
import { SELLER_PLACEHOLDER } from "../models/invoice.server";
import { formatDate } from "../utils/vendor-display";

const ACTOR = "merchant";

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
      holdDays: String(settings.payoutHoldDays),
      minimum: String(settings.payoutMinimum),
      requests: settings.payoutRequests,
      schedule: settings.payoutSchedule,
      refundKeepsCommission: settings.refundKeepsCommission,
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
    // As with carrier keys, only whether email is connected leaves the server.
    email: {
      provider: settings.emailProvider ? EMAIL_PROVIDERS[settings.emailProvider]?.label : null,
      from: settings.emailFrom || PLACEHOLDER_FROM,
      providers: Object.entries(EMAIL_PROVIDERS).map(([value, provider]) => ({ value, label: provider.label })),
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
      holdDays: formData.get("holdDays"),
      minimum: formData.get("minimum"),
      requests: formData.get("requests") === "on",
      schedule: String(formData.get("schedule") ?? ""),
      refundKeepsCommission: formData.get("refundKeepsCommission") === "on",
    });
    return { intent, errors: result.errors ?? null, saved: Boolean(result.saved) };
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

  if (intent === "connectEmail") {
    const result = await connectEmail(session.shop, {
      provider: String(formData.get("provider") ?? ""),
      apiKey: String(formData.get("apiKey") ?? ""),
      from: String(formData.get("from") ?? ""),
      replyTo: String(formData.get("replyTo") ?? ""),
    });
    return { intent, error: result.error ?? null, errors: result.errors ?? null, saved: Boolean(result.ok) };
  }

  if (intent === "disconnectEmail") {
    await disconnectEmail(session.shop);
    return { intent, error: null, saved: true };
  }

  if (intent === "testEmail") {
    const to = String(formData.get("to") ?? "").trim();
    const result = await sendEmail(session.shop, {
      to,
      subject: "A test from StoreVendor",
      text: "This is a test message from StoreVendor.\n\nIf you can read it, vendor emails will reach people the same way.",
      template: "test",
    });
    return {
      intent,
      error: result.error ?? (result.skipped === "No valid address" ? "Enter an email address to send it to" : null),
      tested: result.sent ? "Sent. Check the inbox." : result.skipped ? "No provider yet, so it's only in the email log." : null,
    };
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
  } = useLoaderData();
  const taxErrors = actionData?.intent === "taxReporting" ? (actionData.errors ?? {}) : {};
  const invoiceErrors = actionData?.intent === "invoices" ? (actionData.errors ?? {}) : {};
  const emailErrors = actionData?.intent === "connectEmail" ? (actionData.errors ?? {}) : {};
  const actionData = useActionData();
  const navigation = useNavigation();
  const shopify = useAppBridge();
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
            <s-grid gridTemplateColumns="minmax(0,1fr) minmax(0,1fr)" gap="base">
              <s-number-field
                label="Hold after shipping"
                name="holdDays"
                suffix="days"
                inputMode="numeric"
                step={1}
                min={0}
                max={90}
                defaultValue={payouts.holdDays}
                error={actionData?.intent === "payouts" ? actionData.errors?.holdDays : undefined}
                required
              ></s-number-field>
              <s-number-field
                label="Smallest payout"
                name="minimum"
                suffix={currencyCode}
                inputMode="decimal"
                step={0.01}
                min={0}
                defaultValue={payouts.minimum}
                details="Balances below this wait until they're worth a transfer."
                error={actionData?.intent === "payouts" ? actionData.errors?.minimum : undefined}
              ></s-number-field>
            </s-grid>
            <s-grid gridTemplateColumns="minmax(0,20rem)" gap="base">
              <s-select
                label="Set payouts aside"
                name="schedule"
                value={payouts.schedule}
                details="Everyone due goes onto your To send list. You still send the money yourself."
              >
                <s-option value="MANUAL">When I click Pay</s-option>
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

      <s-section heading="Email">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Vendors are emailed when their money moves. Connect Resend or Postmark to send from your
            own domain. Until then every message is kept in the email log, so nothing is lost.
          </s-paragraph>
          {["connectEmail", "testEmail"].includes(actionData?.intent) && actionData.error && (
            <s-banner tone="critical">{actionData.error}</s-banner>
          )}
          {actionData?.intent === "testEmail" && actionData.tested && (
            <s-banner tone="info">{actionData.tested}</s-banner>
          )}

          {email.provider ? (
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-badge tone="success">{`Sending with ${email.provider}`}</s-badge>
              <s-text color="subdued">{email.from}</s-text>
              <Form method="post">
                <input type="hidden" name="intent" value="disconnectEmail" />
                <s-button type="submit" variant="tertiary" tone="critical">
                  Disconnect
                </s-button>
              </Form>
            </s-stack>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="connectEmail" />
              <s-stack direction="block" gap="base">
                <s-grid gridTemplateColumns="minmax(0,12rem) minmax(0,1fr)" gap="base">
                  <s-select label="Provider" name="provider" value="RESEND">
                    {email.providers.map((provider) => (
                      <s-option key={provider.value} value={provider.value}>
                        {provider.label}
                      </s-option>
                    ))}
                  </s-select>
                  <s-password-field
                    label="API key or server token"
                    name="apiKey"
                    autocomplete="off"
                    error={emailErrors.apiKey}
                    required
                  ></s-password-field>
                </s-grid>
                <s-grid gridTemplateColumns="minmax(0,1fr) minmax(0,1fr)" gap="base">
                  <s-text-field
                    label="Send from"
                    name="from"
                    placeholder="Your Store <payouts@yourstore.com>"
                    details="On a domain you've verified with the provider."
                    error={emailErrors.from}
                    required
                  ></s-text-field>
                  <s-email-field
                    label="Replies go to (optional)"
                    name="replyTo"
                    placeholder="support@yourstore.com"
                    error={emailErrors.replyTo}
                  ></s-email-field>
                </s-grid>
                <s-stack direction="inline">
                  <s-button type="submit" loading={submittingIntent === "connectEmail"}>
                    Connect
                  </s-button>
                </s-stack>
              </s-stack>
            </Form>
          )}

          <Form method="post">
            <input type="hidden" name="intent" value="testEmail" />
            <s-grid gridTemplateColumns="minmax(0,1fr) auto auto" gap="base" alignItems="end">
              <s-email-field label="Send a test to" name="to" placeholder="you@yourstore.com"></s-email-field>
              <s-button type="submit" loading={submittingIntent === "testEmail"}>
                Send test
              </s-button>
              <s-button variant="tertiary" href="/app/emails">
                Email log
              </s-button>
            </s-grid>
          </Form>
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
