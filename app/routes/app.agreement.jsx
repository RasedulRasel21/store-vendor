import { useEffect } from "react";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  agreementOverview,
  discardAgreementDraft,
  publishAgreement,
  saveAgreementDraft,
} from "../models/agreement.server";
import db from "../db.server";
import { formatDate, formatDateTime } from "../utils/vendor-display";

const SAMPLE = `1. Who we are
This agreement is between our store and you, the seller.

2. Your products
You confirm you own or may sell everything you list, that your descriptions are honest,
and that your products are legal to sell where we sell them.

3. Money
We keep the commission shown in your portal on each sale. We pay out the rest after the
hold period, once an order is paid and sent.

4. Shipping and returns
You send orders within the time shown in your portal, and handle returns for your own
products.

5. Ending this
Either of us can end this with notice. Anything already sold is still owed to you.`;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const { current, draft, accepted, owing } = await agreementOverview(session.shop);

  // Who has signed what, so the merchant can see the record rather than take it on trust.
  const signed = current
    ? await db.vendorAgreementAcceptance.findMany({
        where: { agreementId: current.id },
        orderBy: { acceptedAt: "desc" },
        take: 100,
        include: { vendor: { select: { id: true, name: true } } },
      })
    : [];

  const waiting = current
    ? await db.vendor.findMany({
        where: { shop: session.shop, status: "ACTIVE", agreementAcceptances: { none: { agreementId: current.id } } },
        orderBy: { name: "asc" },
        take: 100,
        select: { id: true, name: true },
      })
    : [];

  return {
    sample: SAMPLE,
    current: current
      ? {
          version: current.version,
          title: current.title,
          body: current.body,
          publishedAt: formatDate(current.publishedAt),
        }
      : null,
    draft: draft ? { version: draft.version, title: draft.title, body: draft.body } : null,
    accepted,
    owing,
    signed: signed.map((row) => ({
      id: row.id,
      vendorId: row.vendor.id,
      vendorName: row.vendor.name,
      signedName: row.signedName,
      signedEmail: row.signedEmail,
      acceptedAt: formatDateTime(row.acceptedAt),
    })),
    waiting,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "save") {
    const result = await saveAgreementDraft(session.shop, {
      title: formData.get("title"),
      body: formData.get("body"),
    });
    return { intent, errors: result.errors ?? null, saved: Boolean(result.saved) };
  }

  if (intent === "publish") {
    const result = await publishAgreement(session.shop);
    return { intent, error: result.error ?? null, published: Boolean(result.published), version: result.version };
  }

  if (intent === "discard") {
    await discardAgreementDraft(session.shop);
    return { intent, discarded: true };
  }

  return { intent, error: "Unknown action" };
};

export default function Agreement() {
  const { current, draft, accepted, owing, signed, waiting, sample } = useLoaderData();
  const result = useActionData();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const busy = navigation.state === "submitting" ? navigation.formData?.get("intent") : null;

  useEffect(() => {
    if (result?.saved) shopify.toast.show("Saved");
    if (result?.published) shopify.toast.show(`Version ${result.version} is live`);
  }, [result, shopify]);

  return (
    <s-page heading="Seller agreement">
      {result?.error && <s-banner tone="critical">{result.error}</s-banner>}

      <s-section heading={current ? `Version ${current.version}, in force` : "No agreement yet"}>
        <s-stack direction="block" gap="base">
          {current ? (
            <>
              <s-stack direction="inline" gap="small" alignItems="center">
                <s-badge tone="success">{`Published ${current.publishedAt}`}</s-badge>
                <s-text color="subdued">
                  {`${accepted} ${accepted === 1 ? "vendor has" : "vendors have"} agreed`}
                </s-text>
                {owing > 0 && <s-badge tone="warning">{`${owing} still to agree`}</s-badge>}
              </s-stack>
              <s-paragraph color="subdued">
                Vendors who haven&apos;t agreed to this version are asked to when they next
                open their portal, and can&apos;t use it until they do. A published version
                is never changed — to alter the terms, write a new version below.
              </s-paragraph>
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-text type="strong">{current.title}</s-text>
                <s-paragraph color="subdued">{current.body.slice(0, 400)}{current.body.length > 400 ? "…" : ""}</s-paragraph>
              </s-box>
            </>
          ) : (
            <s-paragraph color="subdued">
              Nothing is asked of your vendors yet. Write your terms below and publish them;
              from then on every vendor signs before they can use their portal, and the
              record is kept here.
            </s-paragraph>
          )}
        </s-stack>
      </s-section>

      <s-section heading={draft ? `Version ${draft.version}, not published yet` : "Write a new version"}>
        <Form method="post">
          <input type="hidden" name="intent" value="save" />
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Title"
              name="title"
              defaultValue={draft?.title ?? "Seller agreement"}
              maxLength={200}
            ></s-text-field>
            <s-text-area
              label="Terms"
              name="body"
              rows={16}
              defaultValue={draft?.body ?? (current ? current.body : sample)}
              details="Plain text. Vendors read this and type their name to sign it."
              error={result?.intent === "save" ? result.errors?.body : undefined}
            ></s-text-area>
            <s-stack direction="inline" gap="base">
              <s-button type="submit" loading={busy === "save"}>
                Save draft
              </s-button>
            </s-stack>
          </s-stack>
        </Form>

        {draft && (
          <s-stack direction="block" gap="base">
            <s-divider></s-divider>
            <s-paragraph color="subdued">
              Publishing version {draft.version} asks every vendor to agree again, including
              those who agreed to an earlier version. Save your changes first.
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <Form method="post">
                <input type="hidden" name="intent" value="publish" />
                <s-button type="submit" variant="primary" loading={busy === "publish"}>
                  {`Publish version ${draft.version}`}
                </s-button>
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="discard" />
                <s-button type="submit" variant="tertiary" tone="critical" loading={busy === "discard"}>
                  Throw the draft away
                </s-button>
              </Form>
            </s-stack>
          </s-stack>
        )}
      </s-section>

      {current && (
        <s-section heading="Who has agreed">
          {signed.length === 0 ? (
            <s-paragraph color="subdued">Nobody has agreed to this version yet.</s-paragraph>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Vendor</s-table-header>
                <s-table-header listSlot="secondary">Signed as</s-table-header>
                <s-table-header listSlot="labeled">When</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {signed.map((row) => (
                  <s-table-row key={row.id}>
                    <s-table-cell>
                      <s-link href={`/app/vendors/${row.vendorId}`}>{row.vendorName}</s-link>
                    </s-table-cell>
                    <s-table-cell>{`${row.signedName} · ${row.signedEmail}`}</s-table-cell>
                    <s-table-cell>{row.acceptedAt}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}

          {waiting.length > 0 && (
            <s-box padding="base">
              <s-stack direction="block" gap="small">
                <s-text type="strong">{`Still to agree (${waiting.length})`}</s-text>
                <s-text color="subdued">
                  {waiting.map((vendor) => vendor.name).join(", ")}
                </s-text>
              </s-stack>
            </s-box>
          )}
        </s-section>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
