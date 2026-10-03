import db from "../db.server";
import { reportError } from "./error-report.server";
import { fetchActiveSubscription, partnerApiConfigured } from "../partner-api.server";
import { PLANS, planFromHandle, planThatUnlocks } from "../utils/plans";

// The plans themselves live in app/utils/plans.js, which holds no database and so can be
// read by a page as well as by the server. This is the part that needs both.
export { FEATURES, PLANS, PLAN_ORDER, nextPlanUp, planThatUnlocks } from "../utils/plans";

const FRESH_FOR_MS = 15 * 60 * 1000;

/**
 * Reads the shop's plan, asking Shopify again only when what we have has gone stale.
 *
 * Never locks a paying merchant out. If the Partner API can't be reached, or answers with
 * a plan we don't recognise, the store keeps what it had — losing a feature you paid for
 * because of our network is worse than briefly giving one away.
 */
export async function refreshPlan(admin, shop, { force = false } = {}) {
  const settings = await db.shopSettings.findUnique({
    where: { shop },
    select: { plan: true, planHandle: true, planCheckedAt: true, planTrialEndsAt: true },
  });

  const fresh =
    settings?.planCheckedAt && Date.now() - settings.planCheckedAt.getTime() < FRESH_FOR_MS;
  if (!force && fresh) return current(settings);

  // Nothing set up yet: every feature is on, so development and testing aren't blocked by
  // billing that doesn't exist. In production the variables are set and this never runs.
  if (!partnerApiConfigured()) return { ...current({ plan: "SCALE" }), unconfigured: true };

  try {
    const shopResponse = await admin.graphql(`#graphql
      query ShopId { shop { id } }`);
    const { data } = await shopResponse.json();
    const shopId = data?.shop?.id;
    if (!shopId) throw new Error("Shopify didn't say which shop this is");

    const { subscription } = await fetchActiveSubscription(shopId);

    const item = subscription?.items?.[0];
    const matched = subscription ? planFromHandle(item?.handle, item?.description) : null;

    if (subscription && !matched) {
      // They are paying for something. Which plan it is we can't tell, so they get
      // everything until we fix the mapping — and we are told about it now.
      await reportError(`Unknown plan handle "${item?.handle ?? "none"}"`, {
        context: "billing:unknown-plan",
        shop,
        details: { handle: item?.handle ?? null, description: item?.description ?? null },
      });
    }

    const plan = subscription ? (matched ?? "SCALE") : "NONE";

    await db.shopSettings.update({
      where: { shop },
      data: {
        plan,
        planHandle: item?.handle ?? null,
        planTrialEndsAt: subscription?.trialEndsAt ? new Date(subscription.trialEndsAt) : null,
        planCheckedAt: new Date(),
      },
    });

    return current({ plan, planHandle: item?.handle ?? null, planTrialEndsAt: subscription?.trialEndsAt ?? null });
  } catch (error) {
    await reportError(error, { context: "billing:check", shop });
    // The last good answer, rather than treating a blip as "they stopped paying".
    return { ...current(settings ?? { plan: "NONE" }), stale: true };
  }
}

// What the rest of the app reads: no Shopify call, just what was last written down.
export async function planFor(shop) {
  const settings = await db.shopSettings.findUnique({
    where: { shop },
    select: { plan: true, planHandle: true, planTrialEndsAt: true },
  });

  if (!settings) return current({ plan: "NONE" });
  // Billing isn't set up on this deployment, so nothing is held back.
  if (!partnerApiConfigured()) return { ...current({ plan: "SCALE" }), unconfigured: true };

  return current(settings);
}

function current(settings) {
  const key = settings?.plan && PLANS[settings.plan] ? settings.plan : null;
  const plan = key ? PLANS[key] : null;

  return {
    key: key ?? "NONE",
    name: plan?.name ?? "No plan",
    price: plan?.price ?? 0,
    vendorLimit: plan?.vendorLimit ?? 0,
    features: plan?.features ?? [],
    subscribed: Boolean(plan),
    handle: settings?.planHandle ?? null,
    trialEndsAt: settings?.planTrialEndsAt ?? null,
    has(feature) {
      return Boolean(plan?.features.includes(feature));
    },
  };
}

/**
 * How many more vendors this store can have. Counts the ones that take up a place:
 * active and pending, not rejected or suspended, because a suspended vendor isn't
 * selling and shouldn't cost the merchant a seat.
 */
export async function vendorAllowance(shop) {
  const plan = await planFor(shop);
  const used = await db.vendor.count({ where: { shop, status: { in: ["ACTIVE", "PENDING"] } } });

  return {
    used,
    limit: plan.vendorLimit,
    left: Math.max(0, plan.vendorLimit - used),
    full: used >= plan.vendorLimit,
    plan,
  };
}

/**
 * Stops a locked feature being used, whatever the page shows. The UI says what a plan
 * includes; this is what actually holds, because a form can always be posted by hand.
 *
 * @returns {Promise<{error: string}|null>} an error to hand back, or null to carry on
 */
export async function requireFeature(shop, feature) {
  const plan = await planFor(shop);
  if (plan.has(feature)) return null;

  const needed = planThatUnlocks(feature);
  return {
    error: plan.subscribed
      ? `That's part of the ${needed.name} plan. Change plan to switch it on.`
      : "Pick a plan to switch this on.",
  };
}
