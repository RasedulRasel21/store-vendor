import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { recentEmails } from "../models/email.server";
import { formatDateTime } from "../utils/vendor-display";

const STATUS = {
  QUEUED: { label: "Sending", tone: "info" },
  SENT: { label: "Sent", tone: "success" },
  FAILED: { label: "Failed", tone: "critical" },
  SKIPPED: { label: "Logged only", tone: "neutral" },
};

// Every message the app sent or would have sent, word for word, so the merchant can see
// what a vendor was told and when.
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const emails = await recentEmails(session.shop, 50);

  return {
    emails: emails.map((email) => ({
      id: email.id,
      to: email.to,
      subject: email.subject,
      text: email.text,
      template: email.template,
      status: email.status,
      error: email.error,
      createdAt: formatDateTime(email.createdAt),
    })),
  };
};

export default function EmailLog() {
  const { emails } = useLoaderData();

  return (
    <s-page heading="Email log">
      <s-link slot="breadcrumb-actions" href="/app/settings">
        Settings
      </s-link>

      {emails.length === 0 ? (
        <s-section>
          <s-paragraph color="subdued">No emails yet. They appear here as vendors are notified.</s-paragraph>
        </s-section>
      ) : (
        emails.map((email) => {
          const status = STATUS[email.status];
          return (
            <s-section key={email.id} heading={email.subject}>
              <s-stack direction="block" gap="small">
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-badge tone={status.tone}>{status.label}</s-badge>
                  <s-text color="subdued">{`To ${email.to} · ${email.createdAt} · ${email.template}`}</s-text>
                </s-stack>
                {email.error && email.status === "FAILED" && <s-text tone="critical">{email.error}</s-text>}
                <s-box padding="base" background="subdued" borderRadius="base">
                  <s-stack direction="block" gap="small">
                    {email.text.split("\n").map((line, index) => (
                      <s-text key={index}>{line || " "}</s-text>
                    ))}
                  </s-stack>
                </s-box>
              </s-stack>
            </s-section>
          );
        })
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
