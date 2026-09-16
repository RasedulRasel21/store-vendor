import { authenticate } from "../shopify.server";
import { updatePaymentStatus } from "../models/vendor-order.server";

// orders/paid and orders/updated both land here: they keep the payment status current,
// which matters for cash on delivery, where an order is paid days after it's placed.
const STATUS_BY_PAYLOAD = {
  paid: "PAID",
  partially_refunded: "PARTIALLY_REFUNDED",
  refunded: "REFUNDED",
  pending: "PENDING",
  authorized: "AUTHORIZED",
  partially_paid: "PARTIALLY_PAID",
  voided: "VOIDED",
  expired: "EXPIRED",
};

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const orderGid = payload?.admin_graphql_api_id ?? (payload?.id ? `gid://shopify/Order/${payload.id}` : null);
  const financialStatus = STATUS_BY_PAYLOAD[payload?.financial_status] ?? null;

  if (orderGid) await updatePaymentStatus(shop, orderGid, financialStatus);

  return new Response();
};
