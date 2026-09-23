import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getVendorOverview } from "../models/vendor.server";
import { dismissSetupGuide, getShopSettings } from "../models/settings.server";
import db from "../db.server";
import { holdOf, vendorBalances } from "../models/ledger.server";
import { formatMoney } from "../utils/money";
import { OVERDUE_WHERE } from "../models/vendor-order.server";
import { formatDate } from "../utils/vendor-display";

// How far back a problem still counts as something to act on today. Worked out per
// request: a server that stays up for a week would otherwise keep asking about the same
// fortnight it booted in.
const recently = () => new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [overview, settings] = await Promise.all([
    getVendorOverview(session.shop),
    getShopSettings(session.shop),
  ]);
  const [balances, payoutsToSend, payoutRequests, bounced, overdueOrders, unpayable] =
    await Promise.all([
      vendorBalances(session.shop, { hold: holdOf(settings) }),
      db.payout.count({ where: { shop: session.shop, status: "PENDING" } }),
      db.payout.count({ where: { shop: session.shop, status: "REQUESTED" } }),
      // A transfer that bounced put the money back on the vendor's balance, so it needs
      // sending again. Only recent ones: an old failure has long since been dealt with.
      db.payout.count({
        where: { shop: session.shop, status: "FAILED", updatedAt: { gte: recently() } },
      }),
      db.vendorOrder.count({
        where: { shop: session.shop, ...OVERDUE_WHERE(settings.fulfillmentDays) },
      }),
      db.vendor.findMany({
        where: { shop: session.shop, status: "ACTIVE", payoutMethod: null },
        select: { id: true },
      }),
    ]);
  const availableToPay = [...balances.values()].reduce(
    (sum, balance) => sum + Math.max(0, balance.available),
    0,
  );
  // Vendors who have earned something but have nowhere for it to go.
  const waitingOnDetails = unpayable.filter(
    (vendor) => (balances.get(vendor.id)?.available ?? 0) > 0,
  ).length;

  return {
    ...overview,
    alerts: {
      bounced,
      overdueOrders,
      waitingOnDetails,
      fulfillmentDays: settings.fulfillmentDays,
    },
    availableToPay: formatMoney(availableToPay, settings.currencyCode ?? "USD"),
    payoutsToSend: payoutsToSend + payoutRequests,
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
    changesToReview,
    ordersToShip,
    availableToPay,
    payoutsToSend,
    setupGuideDismissed,
    alerts,
  } = useLoaderData();

  // Only things that are wrong now and can be acted on, worst first. Nothing wrong, no
  // section: a panel that's always there stops being read.
  const problems = [
    alerts.bounced && {
      id: "bounced",
      tone: "critical",
      text:
        alerts.bounced === 1
          ? "A payout bounced. That money is owed again and needs sending."
          : `${alerts.bounced} payouts bounced. That money is owed again and needs sending.`,
      action: "Open payouts",
      href: "/app/payouts?tab=closed",
    },
    alerts.waitingOnDetails && {
      id: "details",
      tone: "warning",
      text:
        alerts.waitingOnDetails === 1
          ? "A vendor has earned money but hasn't added payout details, so there's nowhere to send it."
          : `${alerts.waitingOnDetails} vendors have earned money but haven't added payout details.`,
      action: "See who",
      href: "/app/payouts",
    },
    alerts.overdueOrders && {
      id: "overdue",
      tone: "warning",
      text:
        alerts.overdueOrders === 1
          ? `An order hasn't shipped within ${alerts.fulfillmentDays} days.`
          : `${alerts.overdueOrders} orders haven't shipped within ${alerts.fulfillmentDays} days.`,
      action: "Chase them",
      href: "/app/orders?overdue=1",
    },
  ].filter(Boolean);
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
      label: "Setting changes to review",
      value: changesToReview,
      href: "/app/changes",
    },
    {
      label: "Vendor orders to ship",
      value: ordersToShip,
      href: "/app/orders",
    },
    {
      label: "Available to pay vendors",
      value: availableToPay,
      href: "/app/payouts",
    },
    {
      label: "Payouts to send or accept",
      value: payoutsToSend,
      href: "/app/payouts",
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

      {problems.length > 0 && (
        <s-section heading="Needs your attention">
          <s-stack direction="block" gap="base">
            {problems.map((problem) => (
              <s-grid
                key={problem.id}
                gridTemplateColumns="auto 1fr auto"
                gap="base"
                alignItems="center"
              >
                <s-badge tone={problem.tone}>
                  {problem.tone === "critical" ? "Action needed" : "Check"}
                </s-badge>
                <s-text>{problem.text}</s-text>
                <s-button variant="secondary" href={problem.href}>
                  {problem.action}
                </s-button>
              </s-grid>
            ))}
          </s-stack>
        </s-section>
      )}

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
