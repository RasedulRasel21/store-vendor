import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { planFor, refreshPlan, vendorAllowance } from "../models/plan.server";
import { planSelectionUrl } from "../partner-api.server";
import { PLAN_ORDER, PLANS } from "../utils/plans";
import { formatDate } from "../utils/vendor-display";

// What each plan is worth saying out loud, in the merchant's terms rather than ours.
const WHAT_YOU_GET = {
  STARTER: [
    "Vendor portal, product approvals and order splitting",
    "Commission ledger, with refunds reversing automatically",
    "Per-vendor shipping rates at checkout, and packing slips",
    "Vendor pages on your storefront, and an apply-to-sell page",
    "Manual payouts with a bank file",
  ],
  GROWTH: [
    "Automatic payouts through PayPal and Stripe",
    "Cash on delivery, with limits per vendor",
    "Commission invoices and a signed seller agreement",
    "Staff accounts and permissions for your sellers",
    "Bulk product edits, CSV import and export",
  ],
  SCALE: [
    "Tax reporting: 1099-K and DAC7",
    "Payouts in other currencies, at live rates",
    "Shipping labels through Shippo or EasyPost",
    "Priority support",
  ],
};

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Looking at this page is the one moment a merchant expects the plan to be right, so
  // it's asked for again rather than read from what was cached a quarter of an hour ago.
  await refreshPlan(admin, session.shop, { force: true });
  const [plan, room] = await Promise.all([planFor(session.shop), vendorAllowance(session.shop)]);

  return {
    plan: {
      key: plan.key,
      name: plan.name,
      price: plan.price,
      subscribed: plan.subscribed,
      unconfigured: Boolean(plan.unconfigured),
      trialEndsAt: formatDate(plan.trialEndsAt),
    },
    vendors: { used: room.used, limit: room.limit, full: room.full },
    changeUrl: planSelectionUrl(session.shop),
    plans: PLAN_ORDER.map((key) => ({
      key,
      name: PLANS[key].name,
      price: PLANS[key].price,
      vendorLimit: PLANS[key].vendorLimit,
      includes: WHAT_YOU_GET[key],
      current: plan.key === key,
    })),
  };
};

export default function Plan() {
  const { plan, vendors, changeUrl, plans } = useLoaderData();

  return (
    <s-page heading="Your plan">
      {plan.unconfigured ? (
        <s-banner tone="info" heading="Billing isn't switched on for this deployment">
          Every feature is available. Set the Partner API variables and plans will apply.
        </s-banner>
      ) : plan.subscribed ? (
        <s-banner
          tone={vendors.full ? "warning" : "success"}
          heading={`You're on ${plan.name}, ${plan.price} a month`}
        >
          {plan.trialEndsAt
            ? `Free until ${plan.trialEndsAt}. ${vendors.used} of ${vendors.limit} vendors used.`
            : `${vendors.used} of ${vendors.limit} vendors used.`}
        </s-banner>
      ) : (
        <s-banner tone="critical" heading="No plan chosen yet">
          Pick a plan to start using the marketplace.
        </s-banner>
      )}

      {plans.map((entry) => (
        <s-section
          key={entry.key}
          heading={`${entry.name} — $${entry.price} a month`}
        >
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-badge tone={entry.current ? "success" : "neutral"}>
                {entry.current ? "Your plan" : `Up to ${entry.vendorLimit} vendors`}
              </s-badge>
              {entry.current && <s-text color="subdued">{`Up to ${entry.vendorLimit} vendors`}</s-text>}
            </s-stack>

            <s-unordered-list>
              {entry.includes.map((line) => (
                <s-list-item key={line}>{line}</s-list-item>
              ))}
            </s-unordered-list>

            {entry.key !== "STARTER" && (
              <s-paragraph color="subdued">Everything in the plan before it, too.</s-paragraph>
            )}
          </s-stack>
        </s-section>
      ))}

      <s-section heading="Changing plan">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Plans are handled by Shopify, so changing one happens in your Shopify admin and
            appears on your normal Shopify invoice. Nothing you&apos;ve set up is lost when you
            move between plans — features that aren&apos;t in a plan are switched off, not
            deleted, and come back if you move up again.
          </s-paragraph>
          {changeUrl ? (
            <s-stack direction="inline">
              <s-button variant="primary" href={changeUrl} target="_top">
                See plans and change
              </s-button>
            </s-stack>
          ) : (
            <s-paragraph color="subdued">
              The plan page isn&apos;t set up yet on this deployment.
            </s-paragraph>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
