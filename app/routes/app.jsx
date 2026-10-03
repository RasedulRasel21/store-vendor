import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { ensureCodRules } from "../models/cod-rules.server";
import { ensureCollectionsSynced } from "../models/collection.server";
import { ensureShopCurrency } from "../models/settings.server";
import { reportError } from "../models/error-report.server";
import { refreshPlan } from "../models/plan.server";
import { planSelectionUrl } from "../partner-api.server";

export const loader = async ({ request }) => {
  const { admin, session, redirect } = await authenticate.admin(request);

  // Which plan the store is on, asked of Shopify at most every quarter of an hour. Every
  // page goes through here, so nothing else in the app has to remember to check.
  const plan = await refreshPlan(admin, session.shop);

  // Nobody has picked a plan yet, so there is nothing to show them but the plans. Shopify
  // hosts that page, and it lives outside this app's frame.
  if (!plan.subscribed && !plan.unconfigured) {
    const url = planSelectionUrl(session.shop);
    if (url) return redirect(url, { target: "_top" });
  }

  // Shop details the vendor portal needs. Failures are logged, never block the admin,
  // and are retried on the next load.
  const results = await Promise.allSettled([
    ensureShopCurrency(admin, session.shop),
    ensureCollectionsSynced(admin, session.shop),
    ensureCodRules(admin, session.shop),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      await reportError(result.reason, { context: "app:prepare-shop", shop: session.shop });
    }
  }

  return {
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    plan: { key: plan.key, name: plan.name, trialEndsAt: plan.trialEndsAt ?? null },
  };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/vendors">Vendors</s-link>
        <s-link href="/app/orders">Orders</s-link>
        <s-link href="/app/payouts">Payouts</s-link>
        <s-link href="/app/approvals">Product approvals</s-link>
        <s-link href="/app/changes">Setting changes</s-link>
        <s-link href="/app/agreement">Seller agreement</s-link>
        <s-link href="/app/settings">Settings</s-link>
        <s-link href="/app/plan">Plan</s-link>
        <s-link href="/app/health">Health</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
