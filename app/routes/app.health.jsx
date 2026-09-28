import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { resolveError, shopErrors } from "../models/error-report.server";
import { uptimeSummary } from "../models/health.server";
import { formatDate, formatDateTime } from "../utils/vendor-display";

// What a merchant wants to know is "is anything broken, and does it involve me?" — not a
// stack trace. Each place something can fail gets a plain sentence; the technical line is
// still there underneath for whoever ends up fixing it.
const WHAT_HAPPENED = [
  [/^webhook:orders/, "Reading an order from Shopify"],
  [/^webhook:refunds/, "Reading a refund from Shopify"],
  [/^webhook:returns/, "Reading a return from Shopify"],
  [/^webhook:fulfillments/, "Reading a shipment from Shopify"],
  [/^webhook:products/, "Reading a product change from Shopify"],
  [/^webhook:/, "Handling an update from Shopify"],
  [/^payout:/, "Sending a payout"],
  [/^email:/, "Sending an email"],
  [/^shipping:/, "Updating a vendor's delivery rates"],
  [/^product:auto-approve/, "Putting a trusted vendor's product on sale"],
  [/^product:/, "Approving a product"],
  [/^order:cash-collected/, "Marking a cash-on-delivery order paid"],
  [/^cron:health/, "The nightly check"],
  [/^cron:/, "The nightly catch-up"],
  [/^portal/, "The vendor portal"],
  [/^(GET|POST) /, "Opening a page in this app"],
];

const plainly = (context) => WHAT_HAPPENED.find(([pattern]) => pattern.test(context))?.[1] ?? context;

const TARGET_NAME = { app: "This app", portal: "Vendor portal" };

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const [faults, uptime] = await Promise.all([
    shopErrors(session.shop, { limit: 25 }),
    uptimeSummary({ days: 7 }),
  ]);

  // eslint-disable-next-line no-undef
  const healthUrl = new URL("/health", process.env.SHOPIFY_APP_URL ?? request.url).toString();

  return {
    healthUrl,
    uptime: uptime.targets.map((target) => ({
      ...target,
      name: TARGET_NAME[target.target] ?? target.target,
      lastCheckedAt: formatDateTime(target.lastCheckedAt),
      lastFailureAt: formatDateTime(target.lastFailure?.checkedAt ?? null),
      lastFailureDetail: target.lastFailure?.detail ?? null,
    })),
    monitored: uptime.monitored,
    faults: faults.map((fault) => ({
      id: fault.id,
      what: plainly(fault.context),
      context: fault.context,
      message: fault.message,
      count: fault.count,
      source: fault.source,
      firstSeenAt: formatDate(fault.firstSeenAt),
      lastSeenAt: formatDateTime(fault.lastSeenAt),
    })),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") === "resolve") {
    await resolveError(session.shop, String(formData.get("id") ?? ""));
  }

  return null;
};

export default function Health() {
  const { faults, uptime, monitored, healthUrl } = useLoaderData();
  const fetcher = useFetcher();
  // The row goes as soon as it's clicked, rather than after the round trip.
  const clearing = fetcher.formData?.get("id");
  const showing = faults.filter((fault) => fault.id !== clearing);

  return (
    <s-page heading="Is everything working?">
      {showing.length === 0 ? (
        <s-banner heading="Nothing needs your attention" tone="success">
          Nothing has failed in your store recently. Anything that does show up here, in
          plain words, so you find out before your sellers do.
        </s-banner>
      ) : (
        <s-banner
          heading={
            showing.length === 1 ? "One thing needs a look" : `${showing.length} things need a look`
          }
          tone="warning"
        >
          These failed in your store. Most sort themselves out on the next try; the ones that
          don&apos;t are worth sending to support.
        </s-banner>
      )}

      <s-section heading="What went wrong">
        {showing.length === 0 ? (
          <s-paragraph color="subdued">Nothing to show. That&apos;s the good outcome.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">What was happening</s-table-header>
              <s-table-header listSlot="labeled">Times</s-table-header>
              <s-table-header listSlot="labeled">Last seen</s-table-header>
              <s-table-header listSlot="labeled">Clear</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {showing.map((fault) => (
                <s-table-row key={fault.id}>
                  <s-table-cell>
                    <s-stack direction="block" gap="small">
                      <s-text type="strong">{fault.what}</s-text>
                      <s-text color="subdued">{fault.message}</s-text>
                      <s-text color="subdued">
                        {`${fault.source === "portal" ? "Vendor portal" : "Store app"} · ${fault.context} · first seen ${fault.firstSeenAt}`}
                      </s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{fault.count}</s-table-cell>
                  <s-table-cell>{fault.lastSeenAt}</s-table-cell>
                  <s-table-cell>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="resolve" />
                      <input type="hidden" name="id" value={fault.id} />
                      <s-button type="submit" variant="secondary">
                        Mark as sorted
                      </s-button>
                    </fetcher.Form>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Uptime, last 7 days">
        {monitored ? (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">What</s-table-header>
              <s-table-header listSlot="labeled">Up</s-table-header>
              <s-table-header listSlot="labeled">Usual response</s-table-header>
              <s-table-header listSlot="labeled">Last checked</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {uptime.map((target) => (
                <s-table-row key={target.target}>
                  <s-table-cell>
                    <s-stack direction="block" gap="small">
                      <s-text type="strong">{target.name}</s-text>
                      {target.lastFailureAt && (
                        <s-text color="subdued">
                          {`Last failed ${target.lastFailureAt}${target.lastFailureDetail ? ` — ${target.lastFailureDetail}` : ""}`}
                        </s-text>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {target.percent === null ? (
                      <s-text color="subdued">Not checked</s-text>
                    ) : (
                      <s-badge tone={target.percent >= 99.5 ? "success" : target.percent >= 95 ? "warning" : "critical"}>
                        {`${target.percent}%`}
                      </s-badge>
                    )}
                  </s-table-cell>
                  <s-table-cell>{target.averageMs === null ? "—" : `${target.averageMs} ms`}</s-table-cell>
                  <s-table-cell>{target.lastCheckedAt ?? "—"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Nothing is checking on the marketplace yet, so there&apos;s no history to show.
              Point any uptime monitor at the address below — UptimeRobot and Better Stack both
              have a free tier — and set it to check every five minutes. Each check is recorded
              here, and it watches the vendor portal at the same time.
            </s-paragraph>
            <s-box padding="base" background="subdued" borderRadius="base">
              <s-text>{healthUrl}</s-text>
            </s-box>
            <s-paragraph color="subdued">
              Anything other than a 200 response means something is down.
            </s-paragraph>
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
