import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  changeVendorStatus,
  createOwnerInvite,
  getVendor,
  inviteUrl,
  updateVendorCommission,
  updateVendorFulfillment,
  updateVendorNotes,
} from "../models/vendor.server";
import { getShopCurrency, getShopSettings } from "../models/settings.server";
import { effectiveCommission, formatCommission } from "../utils/commission";
import {
  getVendorProducts,
  linkProducts,
  unlinkProduct,
} from "../models/vendor-product.server";
import {
  activityLabel,
  formatDate,
  SHIPPING_MODE,
  SHIPPING_MODES,
  VENDOR_STATUS,
  VENDOR_USER_STATUS,
} from "../utils/vendor-display";

const ACTOR = "merchant";

const SUCCESS_MESSAGES = {
  approve: "Vendor approved",
  reject: "Vendor rejected",
  suspend: "Vendor suspended",
  reactivate: "Vendor reactivated",
  notes: "Notes saved",
  invite: "Invite link created",
  "unlink-product": "Product unlinked",
  commission: "Commission saved",
  fulfillment: "Shipping and cash on delivery saved",
};

const PRODUCT_STATUS_LABEL = {
  ACTIVE: "Active",
  DRAFT: "Draft",
  ARCHIVED: "Archived",
};

export const loader = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const vendor = await getVendor(session.shop, params.id);

  if (!vendor) {
    throw new Response("Vendor not found", { status: 404 });
  }

  const [products, settings, currencyCode] = await Promise.all([
    getVendorProducts(admin, session.shop, vendor.id),
    getShopSettings(session.shop),
    getShopCurrency(admin),
  ]);
  const commission = effectiveCommission(vendor, settings);

  return {
    products,
    currencyCode,
    commission: {
      ...commission,
      label: formatCommission(commission, currencyCode),
      defaultLabel: formatCommission(
        {
          percent: String(settings.commissionPercent),
          fixed: String(settings.commissionFixed),
        },
        currencyCode,
      ),
    },
    // eslint-disable-next-line no-undef
    portalConfigured: Boolean(process.env.VENDOR_PORTAL_URL),
    vendor: {
      id: vendor.id,
      name: vendor.name,
      handle: vendor.handle,
      email: vendor.email,
      phone: vendor.phone,
      status: vendor.status,
      statusReason: vendor.statusReason,
      notes: vendor.notes,
      productCount: vendor._count.products,
      shippingMode: vendor.shippingMode,
      codEnabled: vendor.codEnabled,
      codMaxOrderValue:
        vendor.codMaxOrderValue === null ? "" : String(vendor.codMaxOrderValue),
      createdAt: formatDate(vendor.createdAt),
      approvedAt: formatDate(vendor.approvedAt),
      users: vendor.users.map((user) => ({
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        hasInvite: Boolean(user.inviteTokenHash),
        inviteExpired: user.inviteExpiresAt ? user.inviteExpiresAt < new Date() : false,
        inviteExpiresAt: formatDate(user.inviteExpiresAt),
      })),
      activities: vendor.activities.map((activity) => ({
        id: activity.id,
        label: activityLabel(activity.action),
        reason: activity.details?.reason ?? null,
        date: formatDate(activity.createdAt),
      })),
    },
  };
};

export const action = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  switch (intent) {
    case "approve":
    case "reject":
    case "suspend":
    case "reactivate": {
      const result = await changeVendorStatus(session.shop, params.id, intent, {
        reason: String(formData.get("reason") ?? ""),
        actor: ACTOR,
      });
      return { intent, error: result.error ?? null };
    }
    case "notes": {
      const result = await updateVendorNotes(
        session.shop,
        params.id,
        String(formData.get("notes") ?? ""),
        ACTOR,
      );
      return { intent, error: result.error ?? null };
    }
    case "invite": {
      const result = await createOwnerInvite(session.shop, params.id, ACTOR);
      if (result.error) return { intent, error: result.error };
      return {
        intent,
        error: null,
        inviteToken: result.inviteToken,
        inviteUrl: inviteUrl(result.inviteToken),
      };
    }
    case "fulfillment": {
      const result = await updateVendorFulfillment(
        session.shop,
        params.id,
        {
          shippingMode: formData.get("shippingMode"),
          codEnabled: formData.get("codEnabled") === "on",
          codMaxOrderValue: formData.get("codMaxOrderValue"),
        },
        ACTOR,
      );
      return {
        intent,
        error: result.error ?? null,
        fieldErrors: result.errors ?? null,
      };
    }
    case "commission": {
      const result = await updateVendorCommission(
        session.shop,
        params.id,
        {
          useDefault: formData.get("useDefault") === "on",
          percent: formData.get("percent"),
          fixed: formData.get("fixed"),
        },
        ACTOR,
      );
      return {
        intent,
        error: result.error ?? null,
        fieldErrors: result.errors ?? null,
      };
    }
    case "link-products": {
      let productIds = [];
      try {
        productIds = JSON.parse(String(formData.get("productIds") ?? "[]"));
      } catch {
        return { intent, error: "The product selection couldn't be read" };
      }
      const result = await linkProducts(
        admin,
        session.shop,
        params.id,
        Array.isArray(productIds) ? productIds.map(String) : [],
        ACTOR,
      );
      if (result.error) return { intent, error: result.error };
      return { intent, error: null, linked: result.linked, failed: result.failed };
    }
    case "unlink-product": {
      const result = await unlinkProduct(
        admin,
        session.shop,
        params.id,
        String(formData.get("productId") ?? ""),
        ACTOR,
      );
      return { intent, error: result.error ?? null };
    }
    default:
      return { intent, error: "Unknown action" };
  }
};

export default function VendorDetail() {
  const { vendor, products, commission, currencyCode, portalConfigured } =
    useLoaderData();
  const [useDefaultCommission, setUseDefaultCommission] = useState(
    !commission.custom,
  );
  const [codEnabled, setCodEnabled] = useState(vendor.codEnabled);
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [rejectReason, setRejectReason] = useState("");
  const [suspendReason, setSuspendReason] = useState("");

  const result = fetcher.state === "idle" ? fetcher.data : null;
  const busyIntent =
    fetcher.state === "idle" ? null : fetcher.formData?.get("intent");
  const owner = vendor.users.find((user) => user.role === "OWNER");
  const status = VENDOR_STATUS[vendor.status];

  const canApprove = ["PENDING", "REJECTED"].includes(vendor.status);
  const canReject = vendor.status === "PENDING";
  const canSuspend = vendor.status === "ACTIVE";
  const canReactivate = vendor.status === "SUSPENDED";

  useEffect(() => {
    if (!result || result.error || result.fieldErrors) return;

    if (result.intent === "link-products") {
      const noun = result.linked === 1 ? "product" : "products";
      shopify.toast.show(
        result.failed
          ? `${result.linked} ${noun} linked, ${result.failed} couldn't be updated`
          : `${result.linked} ${noun} linked`,
      );
      return;
    }

    if (SUCCESS_MESSAGES[result.intent]) {
      shopify.toast.show(SUCCESS_MESSAGES[result.intent]);
    }
  }, [result, shopify]);

  const submit = (intent, extra = {}) =>
    fetcher.submit({ intent, ...extra }, { method: "post" });

  const addProducts = async () => {
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: true,
    });
    if (!selection?.length) return;

    submit("link-products", {
      productIds: JSON.stringify(selection.map((product) => product.id)),
    });
  };

  const unlinkingId =
    busyIntent === "unlink-product" ? fetcher.formData?.get("productId") : null;

  const inviteLink = result?.intent === "invite" ? result : null;

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(
        inviteLink.inviteUrl ?? inviteLink.inviteToken,
      );
      shopify.toast.show("Copied");
    } catch {
      shopify.toast.show("Select the link and copy it manually");
    }
  };

  return (
    <s-page heading={vendor.name}>
      <s-link slot="breadcrumb-actions" href="/app/vendors">
        Vendors
      </s-link>
      {canApprove && (
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => submit("approve")}
        >
          Approve
        </s-button>
      )}
      {canReactivate && (
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={() => submit("reactivate")}
        >
          Reactivate
        </s-button>
      )}
      <s-button
        slot="secondary-actions"
        href={`/app/vendors/${vendor.id}/edit`}
      >
        Edit
      </s-button>
      {canReject && (
        <s-button
          slot="secondary-actions"
          commandFor="reject-modal"
          command="--show"
        >
          Reject
        </s-button>
      )}
      {canSuspend && (
        <s-button
          slot="secondary-actions"
          tone="critical"
          commandFor="suspend-modal"
          command="--show"
        >
          Suspend
        </s-button>
      )}

      {result?.error && (
        <s-banner tone="critical" heading="Couldn't update this vendor">
          {result.error}
        </s-banner>
      )}

      {vendor.statusReason &&
        ["REJECTED", "SUSPENDED"].includes(vendor.status) && (
          <s-banner tone="warning" heading={`${status.label}: reason`}>
            {vendor.statusReason}
          </s-banner>
        )}

      <s-section heading="Vendor details">
        <s-grid gridTemplateColumns="auto 1fr" gap="base">
          <s-text color="subdued">Status</s-text>
          <s-stack direction="inline">
            <s-badge tone={status.tone}>{status.label}</s-badge>
          </s-stack>
          <s-text color="subdued">Email</s-text>
          <s-text>{vendor.email}</s-text>
          <s-text color="subdued">Phone</s-text>
          <s-text>{vendor.phone ?? "Not added"}</s-text>
          <s-text color="subdued">Store handle</s-text>
          <s-text>{vendor.handle}</s-text>
          <s-text color="subdued">Products</s-text>
          <s-text>{vendor.productCount}</s-text>
          <s-text color="subdued">Added</s-text>
          <s-text>{vendor.createdAt}</s-text>
          <s-text color="subdued">Approved</s-text>
          <s-text>{vendor.approvedAt ?? "Not approved"}</s-text>
        </s-grid>
      </s-section>

      <s-section heading="Commission">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="commission" />
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {commission.custom
                ? `This vendor has a custom commission of ${commission.label}.`
                : `This vendor uses the store default of ${commission.defaultLabel}.`}
            </s-paragraph>
            <s-checkbox
              name="useDefault"
              value="on"
              label="Use the store default commission"
              details="You can change the default in Settings."
              checked={useDefaultCommission}
              onChange={(event) =>
                setUseDefaultCommission(event.currentTarget.checked)
              }
            ></s-checkbox>
            {!useDefaultCommission && (
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <s-number-field
                  label="Percentage"
                  name="percent"
                  suffix="%"
                  inputMode="decimal"
                  step={0.01}
                  min={0}
                  max={100}
                  defaultValue={commission.percent}
                  error={
                    result?.intent === "commission"
                      ? result.fieldErrors?.percent
                      : undefined
                  }
                ></s-number-field>
                <s-number-field
                  label="Fixed amount per item"
                  name="fixed"
                  suffix={currencyCode}
                  inputMode="decimal"
                  step={0.01}
                  min={0}
                  defaultValue={commission.fixed}
                  error={
                    result?.intent === "commission"
                      ? result.fieldErrors?.fixed
                      : undefined
                  }
                ></s-number-field>
              </s-grid>
            )}
            <s-stack direction="inline">
              <s-button type="submit" loading={busyIntent === "commission"}>
                Save commission
              </s-button>
            </s-stack>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section heading="Shipping and cash on delivery">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="fulfillment" />
          <s-stack direction="block" gap="base">
            <s-choice-list
              label="Who ships this vendor's orders"
              name="shippingMode"
              error={
                result?.intent === "fulfillment"
                  ? result.fieldErrors?.shippingMode
                  : undefined
              }
            >
              {SHIPPING_MODES.map((mode) => (
                <s-choice
                  key={mode}
                  value={mode}
                  defaultSelected={vendor.shippingMode === mode}
                >
                  {SHIPPING_MODE[mode].label}
                  <s-text slot="details">{SHIPPING_MODE[mode].details}</s-text>
                </s-choice>
              ))}
            </s-choice-list>
            <s-checkbox
              name="codEnabled"
              value="on"
              label="Allow cash on delivery"
              details="Controls whether cash on delivery is offered for carts with this vendor's products."
              checked={codEnabled}
              onChange={(event) => setCodEnabled(event.currentTarget.checked)}
            ></s-checkbox>
            {codEnabled && (
              <s-number-field
                label="Maximum order value for cash on delivery"
                name="codMaxOrderValue"
                suffix={currencyCode}
                inputMode="decimal"
                step={0.01}
                min={0}
                defaultValue={vendor.codMaxOrderValue}
                details="Leave empty for no limit."
                error={
                  result?.intent === "fulfillment"
                    ? result.fieldErrors?.codMaxOrderValue
                    : undefined
                }
              ></s-number-field>
            )}
            <s-stack direction="inline">
              <s-button type="submit" loading={busyIntent === "fulfillment"}>
                Save shipping and COD
              </s-button>
            </s-stack>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section heading="Products">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Linking a product sets its Vendor field to {vendor.name}. A product
            can belong to one vendor at a time.
          </s-paragraph>
          <s-stack direction="inline">
            <s-button
              onClick={addProducts}
              loading={busyIntent === "link-products"}
            >
              Add products
            </s-button>
          </s-stack>

          {products.length ? (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header listSlot="inline">Status</s-table-header>
                <s-table-header listSlot="labeled">Action</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {products.map((product) => (
                  <s-table-row key={product.id}>
                    <s-table-cell>{product.title}</s-table-cell>
                    <s-table-cell>
                      {product.status ? (
                        <s-badge>{PRODUCT_STATUS_LABEL[product.status]}</s-badge>
                      ) : (
                        <s-badge tone="critical">Deleted</s-badge>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        variant="tertiary"
                        onClick={() =>
                          submit("unlink-product", { productId: product.id })
                        }
                        loading={unlinkingId === product.id}
                      >
                        Unlink
                      </s-button>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          ) : (
            <s-paragraph color="subdued">No products linked yet.</s-paragraph>
          )}

          {vendor.productCount > products.length && (
            <s-paragraph color="subdued">
              {`Showing the ${products.length} most recently linked of ${vendor.productCount} products.`}
            </s-paragraph>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Portal access">
        <s-stack direction="block" gap="base">
          {vendor.users.map((user) => (
            <s-stack
              key={user.id}
              direction="inline"
              gap="small"
              alignItems="center"
            >
              <s-text>{user.email}</s-text>
              <s-badge>{user.role === "OWNER" ? "Owner" : "Staff"}</s-badge>
              <s-badge tone={VENDOR_USER_STATUS[user.status].tone}>
                {VENDOR_USER_STATUS[user.status].label}
              </s-badge>
            </s-stack>
          ))}

          {owner?.status === "INVITED" && (
            <s-stack direction="block" gap="base">
              <s-paragraph>
                {!owner.hasInvite
                  ? "No invite link has been created yet."
                  : owner.inviteExpired
                    ? "The last invite link has expired."
                    : `The current invite link expires on ${owner.inviteExpiresAt}.`}{" "}
                Creating a new link cancels the previous one.
              </s-paragraph>
              <s-stack direction="inline">
                <s-button
                  onClick={() => submit("invite")}
                  loading={busyIntent === "invite"}
                >
                  Create invite link
                </s-button>
              </s-stack>
            </s-stack>
          )}

          {inviteLink && !inviteLink.error && (
            <s-box padding="base" background="subdued" borderRadius="base">
              <s-stack direction="block" gap="small">
                <s-text type="strong">Send this link to {owner?.email}</s-text>
                <s-text>{inviteLink.inviteUrl ?? inviteLink.inviteToken}</s-text>
                <s-paragraph color="subdued">
                  It&apos;s shown only once and expires in 7 days.
                </s-paragraph>
                {!portalConfigured && (
                  <s-paragraph color="subdued">
                    The vendor portal address isn&apos;t set yet, so this is the
                    invite code only. Add VENDOR_PORTAL_URL to the app&apos;s
                    environment to get full links.
                  </s-paragraph>
                )}
                <s-stack direction="inline">
                  <s-button onClick={copyInvite}>Copy</s-button>
                </s-stack>
              </s-stack>
            </s-box>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Internal notes">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="notes" />
          <s-stack direction="block" gap="base">
            <s-text-area
              label="Notes"
              name="notes"
              defaultValue={vendor.notes ?? ""}
              rows={4}
              details="Only your staff can see these notes."
            ></s-text-area>
            <s-stack direction="inline">
              <s-button type="submit" loading={busyIntent === "notes"}>
                Save notes
              </s-button>
            </s-stack>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section slot="aside" heading="Activity">
        {vendor.activities.length ? (
          <s-unordered-list>
            {vendor.activities.map((activity) => (
              <s-list-item key={activity.id}>
                {`${activity.label} · ${activity.date}`}
                {activity.reason ? `: ${activity.reason}` : ""}
              </s-list-item>
            ))}
          </s-unordered-list>
        ) : (
          <s-paragraph color="subdued">No activity yet.</s-paragraph>
        )}
      </s-section>

      <s-modal id="reject-modal" heading="Reject vendor?">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            The vendor won&apos;t be able to sell on your store. Tell them why
            so they can fix it and reapply.
          </s-paragraph>
          <s-text-area
            label="Reason"
            rows={3}
            value={rejectReason}
            onInput={(event) => setRejectReason(event.currentTarget.value)}
          ></s-text-area>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          commandFor="reject-modal"
          command="--hide"
          disabled={!rejectReason.trim()}
          onClick={() => submit("reject", { reason: rejectReason })}
        >
          Reject vendor
        </s-button>
        <s-button
          slot="secondary-actions"
          commandFor="reject-modal"
          command="--hide"
        >
          Cancel
        </s-button>
      </s-modal>

      <s-modal id="suspend-modal" heading="Suspend vendor?">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            The vendor loses portal access and can&apos;t receive new orders
            until you reactivate them.
          </s-paragraph>
          <s-text-area
            label="Reason (optional)"
            rows={3}
            value={suspendReason}
            onInput={(event) => setSuspendReason(event.currentTarget.value)}
          ></s-text-area>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          commandFor="suspend-modal"
          command="--hide"
          onClick={() => submit("suspend", { reason: suspendReason })}
        >
          Suspend vendor
        </s-button>
        <s-button
          slot="secondary-actions"
          commandFor="suspend-modal"
          command="--hide"
        >
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
