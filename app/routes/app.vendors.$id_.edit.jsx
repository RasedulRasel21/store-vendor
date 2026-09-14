import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getVendor, updateVendor } from "../models/vendor.server";
import { syncVendorName } from "../models/vendor-product.server";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const vendor = await getVendor(session.shop, params.id);

  if (!vendor) {
    throw new Response("Vendor not found", { status: 404 });
  }

  const owner = vendor.users.find((user) => user.role === "OWNER");

  return {
    vendor: {
      id: vendor.id,
      name: vendor.name,
      email: vendor.email,
      phone: vendor.phone ?? "",
    },
    ownerActive: owner?.status === "ACTIVE",
  };
};

export const action = async ({ request, params }) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const formData = await request.formData();

  const values = {
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    phone: String(formData.get("phone") ?? ""),
  };

  const result = await updateVendor(session.shop, params.id, values, "merchant");
  if (result.errors) return { errors: result.errors, values };

  if (result.changed.includes("name")) {
    await syncVendorName(admin, session.shop, result.vendor.id, result.vendor.name);
  }

  return redirect(`/app/vendors/${params.id}`);
};

export default function EditVendor() {
  const { vendor, ownerActive } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const errors = actionData?.errors ?? {};
  const values = actionData?.values ?? vendor;

  return (
    <s-page heading={`Edit ${vendor.name}`} inlineSize="small">
      <s-link slot="breadcrumb-actions" href={`/app/vendors/${vendor.id}`}>
        {vendor.name}
      </s-link>

      {errors.form && (
        <s-banner tone="critical" heading="Couldn't save this vendor">
          {errors.form}
        </s-banner>
      )}

      <Form method="post">
        <s-section>
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Store name"
              name="name"
              defaultValue={values.name}
              error={errors.name}
              details="Renaming also updates the Vendor field on linked products."
              required
            ></s-text-field>
            <s-email-field
              label="Email"
              name="email"
              defaultValue={values.email}
              error={errors.email}
              details={
                ownerActive
                  ? "The vendor's portal login email doesn't change."
                  : "Also used for the vendor's portal invite."
              }
              required
            ></s-email-field>
            <s-text-field
              label="Phone"
              name="phone"
              defaultValue={values.phone}
              error={errors.phone}
              details="Optional."
            ></s-text-field>
            <s-button type="submit" variant="primary" loading={isSubmitting}>
              Save
            </s-button>
          </s-stack>
        </s-section>
      </Form>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
