import { Form, useActionData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { createVendor } from "../models/vendor.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return null;
};

export const action = async ({ request }) => {
  const { session, redirect } = await authenticate.admin(request);
  const formData = await request.formData();

  const values = {
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    phone: String(formData.get("phone") ?? ""),
  };

  const result = await createVendor(session.shop, values, "merchant");
  if (result.errors) return { errors: result.errors, values };

  return redirect(`/app/vendors/${result.vendor.id}`);
};

export default function NewVendor() {
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const errors = actionData?.errors ?? {};
  const values = actionData?.values ?? {};

  return (
    <s-page heading="Add vendor" inlineSize="small">
      <s-link slot="breadcrumb-actions" href="/app/vendors">
        Vendors
      </s-link>

      <Form method="post">
        <s-section>
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Store name"
              name="name"
              defaultValue={values.name}
              error={errors.name}
              required
            ></s-text-field>
            <s-email-field
              label="Email"
              name="email"
              defaultValue={values.email}
              error={errors.email}
              details="Used for the vendor's portal login and notifications."
              required
            ></s-email-field>
            <s-text-field
              label="Phone"
              name="phone"
              defaultValue={values.phone}
              error={errors.phone}
              details="Optional."
            ></s-text-field>
            <s-paragraph color="subdued">
              Vendors you add are approved right away. You can create their
              portal invite link on the next page.
            </s-paragraph>
            <s-button type="submit" variant="primary" loading={isSubmitting}>
              Add vendor
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
