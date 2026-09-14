import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getImportableVendors,
  importVendors,
  MAX_IMPORT_VENDORS,
} from "../models/vendor-import.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const vendors = await getImportableVendors(admin, session.shop);

  return { vendors, maxImport: MAX_IMPORT_VENDORS };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  const selected = formData.getAll("selected").map(String);
  const emails = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("email:")) emails[key.slice("email:".length)] = String(value);
  }

  const rows = selected.map((name) => ({ name, email: emails[name] ?? "" }));
  const result = await importVendors(admin, session.shop, rows, "merchant");

  return { ...result, emails };
};

export default function ImportVendors() {
  const { vendors, maxImport } = useLoaderData();
  const actionData = useActionData();
  const isSubmitting = useNavigation().state === "submitting";

  const errors = actionData?.errors ?? {};
  const results = actionData?.results ?? [];
  const emails = actionData?.emails ?? {};

  return (
    <s-page heading="Import vendors">
      <s-link slot="breadcrumb-actions" href="/app/vendors">
        Vendors
      </s-link>

      {results.length > 0 && (
        <s-banner
          tone="success"
          heading={`${results.length} ${results.length === 1 ? "vendor" : "vendors"} imported`}
        >
          {results
            .map(
              (result) =>
                `${result.name}: ${result.products} products linked${result.truncated ? " (first 1,000 only)" : ""}`,
            )
            .join(". ")}
        </s-banner>
      )}

      {errors.form && (
        <s-banner tone="critical" heading="Couldn't import vendors">
          {errors.form}
        </s-banner>
      )}

      <s-section>
        {vendors.length === 0 ? (
          <s-paragraph>
            There&apos;s nothing to import. Every Vendor name on your products
            is already a vendor here, or your products don&apos;t have a Vendor
            set.
          </s-paragraph>
        ) : (
          <Form method="post">
            <s-stack direction="block" gap="base">
              <s-paragraph color="subdued">
                {`Choose Vendor names from your Shopify products to add as vendors, up to ${maxImport} at a time. Each vendor needs an email for their portal invite. Their products are linked automatically.`}
              </s-paragraph>

              {vendors.map((vendor) => (
                <s-grid
                  key={vendor.name}
                  gridTemplateColumns="1fr 1fr"
                  gap="base"
                  alignItems="center"
                >
                  <s-checkbox
                    name="selected"
                    value={vendor.name}
                    label={vendor.name}
                    details={`${vendor.productCount} ${vendor.productCount === 1 ? "product" : "products"}`}
                    defaultChecked={Boolean(errors[vendor.name])}
                  ></s-checkbox>
                  <s-email-field
                    label={`Email for ${vendor.name}`}
                    labelAccessibilityVisibility="exclusive"
                    name={`email:${vendor.name}`}
                    placeholder="vendor@example.com"
                    defaultValue={emails[vendor.name]}
                    error={errors[vendor.name]}
                  ></s-email-field>
                </s-grid>
              ))}

              <s-stack direction="inline">
                <s-button type="submit" variant="primary" loading={isSubmitting}>
                  Import selected
                </s-button>
              </s-stack>
            </s-stack>
          </Form>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
