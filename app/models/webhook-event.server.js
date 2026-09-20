import db from "../db.server";

// Shopify retries a webhook when the response is slow, fails, or never arrives, and the same
// delivery keeps its id across retries. The id is claimed before the work runs and given back
// if the work throws, so a genuine failure is still retried while a duplicate is not.
export async function handleWebhookOnce({ webhookId, shop, topic }, work) {
  // No id means we can't tell deliveries apart, so do the work and rely on it being idempotent.
  if (!webhookId) {
    await work();
    return new Response();
  }

  try {
    await db.webhookEvent.create({ data: { id: webhookId, shop, topic } });
  } catch (error) {
    if (error.code === "P2002") {
      console.log(`Skipped ${topic} webhook for ${shop}: already handled`);
      return new Response();
    }
    throw error;
  }

  try {
    await work();
  } catch (error) {
    await db.webhookEvent.delete({ where: { id: webhookId } }).catch(() => {});
    throw error;
  }

  return new Response();
}

// Deliveries older than this can't be retried by Shopify any more, so the rows are dead weight.
const KEEP_DAYS = 7;

export function pruneWebhookEvents() {
  return db.webhookEvent.deleteMany({
    where: { receivedAt: { lt: new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000) } },
  });
}
