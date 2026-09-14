import { useEffect } from "react";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getCollectionSyncStatus, syncCollections } from "../models/collection.server";
import {
  getShopCurrency,
  getShopSettings,
  updateDefaultCommission,
} from "../models/settings.server";
import { formatDate } from "../utils/vendor-display";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const [settings, currencyCode, collections] = await Promise.all([
    getShopSettings(session.shop),
    getShopCurrency(admin),
    getCollectionSyncStatus(session.shop),
  ]);

  return {
    currencyCode,
    commission: {
      percent: String(settings.commissionPercent),
      fixed: String(settings.commissionFixed),
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

export default function Settings() {
  const { commission, currencyCode, collections } = useLoaderData();
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
      <Form method="post">
        <input type="hidden" name="intent" value="commission" />
        <s-section heading="Default commission">
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
        </s-section>
      </Form>

      <Form method="post">
        <input type="hidden" name="intent" value="syncCollections" />
        <s-section heading="Collections for vendors">
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
        </s-section>
      </Form>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
