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
  updateRestockLocation,
} from "../models/settings.server";
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
  const { commission, currencyCode, collections, carriers, fulfillmentDays, locations, restockLocationId, labels } =
    useLoaderData();
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
