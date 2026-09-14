import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listVendors } from "../models/vendor.server";
import {
  formatDate,
  VENDOR_STATUS,
  VENDOR_STATUSES,
} from "../utils/vendor-display";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const requested = new URL(request.url).searchParams.get("status");
  const status = VENDOR_STATUSES.includes(requested) ? requested : "";

  const { vendors, counts } = await listVendors(session.shop, { status });

  return {
    status,
    counts,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    vendors: vendors.map((vendor) => ({
      id: vendor.id,
      name: vendor.name,
      email: vendor.email,
      status: vendor.status,
      productCount: vendor._count.products,
      createdAt: formatDate(vendor.createdAt),
    })),
  };
};

export default function VendorsIndex() {
  const { vendors, counts, total, status } = useLoaderData();

  const filters = [
    { value: "", label: "All", count: total },
    ...VENDOR_STATUSES.map((value) => ({
      value,
      label: VENDOR_STATUS[value].label,
      count: counts[value] ?? 0,
    })),
  ];

  return (
    <s-page heading="Vendors">
      <s-button slot="primary-action" variant="primary" href="/app/vendors/new">
        Add vendor
      </s-button>

      {total === 0 ? (
        <s-section>
          <s-stack direction="block" gap="base" alignItems="center">
            <s-heading>Add your first vendor</s-heading>
            <s-paragraph>
              Vendors sell their products on your store. Add one yourself, or
              approve vendors who apply through your storefront.
            </s-paragraph>
            <s-button variant="primary" href="/app/vendors/new">
              Add vendor
            </s-button>
          </s-stack>
        </s-section>
      ) : (
        <s-section padding="none">
          <s-stack direction="inline" gap="small" padding="base">
            {filters.map((filter) => (
              <s-button
                key={filter.value || "all"}
                variant={filter.value === status ? "primary" : "secondary"}
                href={
                  filter.value
                    ? `/app/vendors?status=${filter.value}`
                    : "/app/vendors"
                }
              >
                {`${filter.label} (${filter.count})`}
              </s-button>
            ))}
          </s-stack>

          {vendors.length === 0 ? (
            <s-box padding="base">
              <s-paragraph color="subdued">
                No vendors with this status.
              </s-paragraph>
            </s-box>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Vendor</s-table-header>
                <s-table-header listSlot="secondary">Email</s-table-header>
                <s-table-header listSlot="inline">Status</s-table-header>
                <s-table-header listSlot="labeled" format="numeric">
                  Products
                </s-table-header>
                <s-table-header listSlot="labeled">Added</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {vendors.map((vendor) => (
                  <s-table-row key={vendor.id}>
                    <s-table-cell>
                      <s-link href={`/app/vendors/${vendor.id}`}>
                        {vendor.name}
                      </s-link>
                    </s-table-cell>
                    <s-table-cell>{vendor.email}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={VENDOR_STATUS[vendor.status].tone}>
                        {VENDOR_STATUS[vendor.status].label}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>{vendor.productCount}</s-table-cell>
                    <s-table-cell>{vendor.createdAt}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
