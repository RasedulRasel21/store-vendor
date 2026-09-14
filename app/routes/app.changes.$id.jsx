import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  approveChangeRequest,
  getChangeRequest,
  rejectChangeRequest,
} from "../models/change-request.server";
import { payoutRows } from "../utils/payout";
import { CHANGE_REQUEST_STATUS, formatDate } from "../utils/vendor-display";

const ACTOR = "merchant";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const change = await getChangeRequest(session.shop, params.id);

  if (!change) {
    throw new Response("Change request not found", { status: 404 });
  }

  const isPending = change.status === "PENDING";

  return {
    change: {
      id: change.id,
      status: change.status,
      reviewNote: change.reviewNote,
      requestedAt: formatDate(change.createdAt),
      reviewedAt: formatDate(change.reviewedAt),
      vendor: {
        id: change.vendor.id,
        name: change.vendor.name,
        email: change.vendor.email,
        phone: change.vendor.phone,
      },
      // While pending, compare with what's approved now; afterwards, with what it replaced.
      before: isPending
        ? payoutRows(change.vendor.payoutMethod, change.vendor.payoutDetails)
        : payoutRows(change.previous?.method, change.previous?.details),
      requested: payoutRows(change.requested?.method, change.requested?.details),
    },
  };
};

export const action = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "approve") {
    const result = await approveChangeRequest(session.shop, params.id, ACTOR);
    return { intent, error: result.error ?? null };
  }

  if (intent === "reject") {
    const result = await rejectChangeRequest(
      session.shop,
      params.id,
      String(formData.get("note") ?? ""),
      ACTOR,
    );
    return { intent, error: result.error ?? null };
  }

  return { intent, error: "Unknown action" };
};

// Renders one side of the comparison; values that differ from compareWith are marked.
function payoutColumn(heading, rows, emptyText, compareWith = null) {
  return (
    <s-box padding="base" border="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-heading>{heading}</s-heading>
        {rows.length ? (
          <s-grid gridTemplateColumns="auto 1fr" gap="small">
            {rows.map((row) => {
              const changed =
                compareWith &&
                compareWith.find((other) => other.label === row.label)?.value !== row.value;
              return [
                <s-text key={`${row.label}-label`} color="subdued">
                  {row.label}
                </s-text>,
                <s-stack key={`${row.label}-value`} direction="inline" gap="small">
                  <s-text type={changed ? "strong" : undefined}>{row.value || "—"}</s-text>
                  {changed && <s-badge tone="info">Changed</s-badge>}
                </s-stack>,
              ];
            })}
          </s-grid>
        ) : (
          <s-paragraph color="subdued">{emptyText}</s-paragraph>
        )}
      </s-stack>
    </s-box>
  );
}

export default function ReviewChange() {
  const { change } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [note, setNote] = useState("");

  const result = fetcher.state === "idle" ? fetcher.data : null;
  const approving = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "approve";
  const status = CHANGE_REQUEST_STATUS[change.status];
  const isPending = change.status === "PENDING";

  useEffect(() => {
    if (!result || result.error) return;
    if (result.intent === "approve") shopify.toast.show("Payout details updated");
    if (result.intent === "reject") shopify.toast.show("Change rejected");
  }, [result, shopify]);

  const submit = (intent, extra = {}) => fetcher.submit({ intent, ...extra }, { method: "post" });

  return (
    <s-page heading={`Payout change: ${change.vendor.name}`}>
      <s-link slot="breadcrumb-actions" href="/app/changes">
        Setting changes
      </s-link>
      {isPending && (
        <s-button
          slot="primary-action"
          variant="primary"
          loading={approving}
          onClick={() => submit("approve")}
        >
          Approve change
        </s-button>
      )}
      {isPending && (
        <s-button slot="secondary-actions" commandFor="reject-modal" command="--show">
          Reject
        </s-button>
      )}

      {result?.error && (
        <s-banner tone="critical" heading="Couldn't complete this review">
          {result.error}
        </s-banner>
      )}

      {isPending && (
        <s-banner tone="warning" heading="Confirm with the vendor before approving">
          Changed payout details are a common target for fraud. Contact the vendor
          using a phone number or email you already trust, not details from this
          request, and confirm they asked for this change.
        </s-banner>
      )}

      {change.status === "REJECTED" && change.reviewNote && (
        <s-banner tone="critical" heading="Rejected">
          {change.reviewNote}
        </s-banner>
      )}

      <s-section heading="Payout details">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(16rem, 1fr))" gap="base">
          {payoutColumn(
            isPending ? "Current" : "Before",
            change.before,
            "No payout details before this request.",
          )}
          {payoutColumn(
            "Requested",
            change.requested,
            "No details in this request.",
            change.before,
          )}
        </s-grid>
      </s-section>

      <s-section slot="aside" heading="Request">
        <s-stack direction="block" gap="small">
          <s-stack direction="inline">
            <s-badge tone={status.tone}>{status.label}</s-badge>
          </s-stack>
          <s-link href={`/app/vendors/${change.vendor.id}`}>{change.vendor.name}</s-link>
          <s-text color="subdued">{change.vendor.email}</s-text>
          {change.vendor.phone && <s-text color="subdued">{change.vendor.phone}</s-text>}
          <s-text color="subdued">{`Requested ${change.requestedAt}`}</s-text>
          {change.reviewedAt && <s-text color="subdued">{`Reviewed ${change.reviewedAt}`}</s-text>}
        </s-stack>
      </s-section>

      <s-modal id="reject-modal" heading="Reject this change?">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            The vendor&apos;s current payout details stay the same. They see your note
            in their portal and can send a new request.
          </s-paragraph>
          <s-text-area
            label="Why are you rejecting it?"
            rows={4}
            value={note}
            onInput={(event) => setNote(event.currentTarget.value)}
          ></s-text-area>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          commandFor="reject-modal"
          command="--hide"
          disabled={!note.trim()}
          onClick={() => submit("reject", { note })}
        >
          Reject change
        </s-button>
        <s-button slot="secondary-actions" commandFor="reject-modal" command="--hide">
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
