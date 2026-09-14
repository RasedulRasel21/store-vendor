import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { ensureCodRules } from "../models/cod-rules.server";
import { ensureCollectionsSynced } from "../models/collection.server";
import { ensureShopCurrency } from "../models/settings.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Shop details the vendor portal needs. Failures are logged, never block the admin,
  // and are retried on the next load.
  const results = await Promise.allSettled([
    ensureShopCurrency(admin, session.shop),
    ensureCollectionsSynced(admin, session.shop),
    ensureCodRules(admin, session.shop),
  ]);
  for (const result of results) {
    if (result.status === "rejected") console.error("Couldn't prepare shop data for vendors", result.reason);
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/vendors">Vendors</s-link>
        <s-link href="/app/approvals">Product approvals</s-link>
        <s-link href="/app/settings">Settings</s-link>
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
