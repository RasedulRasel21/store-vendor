import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getVendorOverview } from "../models/vendor.server";
import { dismissSetupGuide, getShopSettings } from "../models/settings.server";
import { formatDate } from "../utils/vendor-display";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [overview, settings] = await Promise.all([
    getVendorOverview(session.shop),
    getShopSettings(session.shop),
  ]);

  return {
    ...overview,
    setupGuideDismissed: Boolean(settings.setupGuideDismissedAt),
    pending: overview.pending.map((vendor) => ({
      id: vendor.id,
      name: vendor.name,
      email: vendor.email,
      createdAt: formatDate(vendor.createdAt),
    })),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") === "dismiss-setup-guide") {
    await dismissSetupGuide(session.shop);
  }

  return null;
};

export default function Index() {
  const {
    counts,
    total,
    linkedProducts,
    invitedVendors,
    pending,
    productsToReview,
    setupGuideDismissed,
  } = useLoaderData();
  const fetcher = useFetcher();
  // Hide the guide as soon as the merchant dismisses it.
  const dismissing = fetcher.formData?.get("intent") === "dismiss-setup-guide";

  const steps = [
    {
      id: "add",
      label: "Add your first vendor",
      done: total > 0,
      href: "/app/vendors/new",
      action: "Add vendor",
    },
    {
      id: "invite",
      label: "Create a portal invite link for a vendor",
      done: invitedVendors > 0,
      href: "/app/vendors",
      action: "Open vendors",
    },
    {
      id: "review",
      label: "Review vendors waiting for approval",
      done: total > 0 && (counts.PENDING ?? 0) === 0,
      href: "/app/vendors?status=PENDING",
      action: "Review",
    },
  ];
  const completedSteps = steps.filter((step) => step.done).length;

  const metrics = [
    {
      label: "Active vendors",
      value: counts.ACTIVE ?? 0,
      href: "/app/vendors?status=ACTIVE",
    },
    {
      label: "Awaiting approval",
      value: counts.PENDING ?? 0,
      href: "/app/vendors?status=PENDING",
    },
    {
      label: "Products to review",
      value: productsToReview,
      href: "/app/approvals",
    },
    {
      label: "Suspended",
      value: counts.SUSPENDED ?? 0,
      href: "/app/vendors?status=SUSPENDED",
    },
    { label: "Linked products", value: linkedProducts, href: "/app/vendors" },
  ];

  return (
    <s-page heading="StoreVendor">
      <s-button slot="primary-action" variant="primary" href="/app/vendors/new">
        Add vendor
      </s-button>

      {completedSteps < steps.length && !setupGuideDismissed && !dismissing && (
        <s-section heading="Set up your marketplace">
          <s-stack direction="block" gap="base">
            <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
              <s-paragraph color="subdued">
                {`${completedSteps} of ${steps.length} steps completed`}
              </s-paragraph>
              <s-button
                variant="tertiary"
                onClick={() =>
                  fetcher.submit(
                    { intent: "dismiss-setup-guide" },
                    { method: "post" },
                  )
                }
              >
                Dismiss
              </s-button>
            </s-grid>
            {steps.map((step) => (
              <s-grid
                key={step.id}
                gridTemplateColumns="auto 1fr auto"
                gap="base"
                alignItems="center"
              >
                <s-badge tone={step.done ? "success" : "neutral"}>
                  {step.done ? "Done" : "To do"}
                </s-badge>
                <s-text>{step.label}</s-text>
                {step.done ? (
                  <s-text color="subdued">Completed</s-text>
                ) : (
                  <s-button href={step.href}>{step.action}</s-button>
                )}
              </s-grid>
            ))}
          </s-stack>
        </s-section>
      )}

      <s-section heading="Overview">
        <s-grid
          gridTemplateColumns="repeat(auto-fit, minmax(10rem, 1fr))"
          gap="base"
        >
          {metrics.map((metric) => (
            <s-clickable
              key={metric.label}
              href={metric.href}
              padding="base"
              border="base"
              borderRadius="base"
            >
              <s-stack direction="block" gap="small">
                <s-text color="subdued">{metric.label}</s-text>
                <s-heading>{String(metric.value)}</s-heading>
              </s-stack>
            </s-clickable>
          ))}
        </s-grid>
      </s-section>

      <s-section heading="Awaiting approval">
        {pending.length ? (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Vendor</s-table-header>
              <s-table-header listSlot="secondary">Email</s-table-header>
              <s-table-header listSlot="labeled">Applied</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {pending.map((vendor) => (
                <s-table-row key={vendor.id}>
                  <s-table-cell>
                    <s-link href={`/app/vendors/${vendor.id}`}>
                      {vendor.name}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>{vendor.email}</s-table-cell>
                  <s-table-cell>{vendor.createdAt}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-paragraph color="subdued">
            No vendors are waiting for approval.
          </s-paragraph>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
