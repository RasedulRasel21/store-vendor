import db from "../db.server";
import { reportError } from "./error-report.server";
import { PLANS, planFromHandle } from "../utils/plans";

// The plans themselves live in app/utils/plans.js, which holds no database and so can be
// read by a page as well as by the server. This is the part that needs both.
export { FEATURES, PLANS, PLAN_ORDER, nextPlanUp, planThatUnlocks } from "../utils/plans";

// Which plan a store is on.
//
// Shopify App Pricing owns the subscription: the plans are set in the Partner Dashboard,
// Shopify hosts the page where a merchant picks one, and this app never creates a charge.
// All it does is ask which plan is active, and let that decide what is switched on.
//
// Asked of the Admin API, through the app's own installation record. No billing scope, no
// billing config, no Partner API credentials — the subscription belongs to this app, so
// the app can see it. (The App Pricing docs point at the Partner API for this; the Admin
// API answers it too, with no setup, which is the same route a published app of ours
// already uses.)
const ACTIVE_PLAN = `#graphql
  query ActivePlan {
    currentAppInstallation {
      activeSubscriptions { id name status test }
      app { handle }
    }
    shop {
      plan { partnerDevelopment }
    }
  }`;

// Long enough that the question isn't asked on every page load, short enough that someone
// who has just paid doesn't sit on their old plan.
const FRESH_FOR_MS = 15 * 60 * 1000;

/**
 * Reads the shop's plan, asking Shopify again only when what we have has gone stale.
 *
 * Never locks a paying merchant out. If the call fails, or the subscription has a name we
 * don't recognise, the store keeps what it had — losing a feature you paid for because of
 * our network or our naming is worse than briefly giving one away.
 */
export async function refreshPlan(admin, shop, { force = false } = {}) {
  const settings = await db.shopSettings.findUnique({
    where: { shop },
    select: { plan: true, planHandle: true, appHandle: true, planCheckedAt: true, planTrialEndsAt: true },
  });

  const fresh =
    settings?.planCheckedAt && Date.now() - settings.planCheckedAt.getTime() < FRESH_FOR_MS;
  if (!force && fresh) return current(settings);

  try {
    const response = await admin.graphql(ACTIVE_PLAN);
    const { data } = await response.json();

    const install = data?.currentAppInstallation;
    const subscriptions = install?.activeSubscriptions ?? [];
    const active = subscriptions.find((entry) => entry?.status === "ACTIVE") ?? subscriptions[0] ?? null;
    const appHandle = install?.app?.handle ?? settings?.appHandle ?? null;

    // A development store with nothing chosen is somebody building or testing, not a
    // merchant dodging the bill. Everything is on, so the app can be worked on before its
    // plans exist and reviewed before anyone has paid.
    const development = Boolean(data?.shop?.plan?.partnerDevelopment) && !active;

    const matched = active ? planFromHandle(active.name, active.name) : null;
    if (active && !matched) {
      // They are paying for something. Which plan it is we can't tell, so they get
      // everything until the naming is put right — and we are told about it now.
      await reportError(`Subscription "${active.name}" matches no plan`, {
        context: "billing:unknown-plan",
        shop,
        details: { name: active.name, status: active.status },
      });
    }

    const plan = development ? "SCALE" : active ? (matched ?? "SCALE") : "NONE";

    await db.shopSettings.update({
      where: { shop },
      data: {
        plan,
        planHandle: active?.name ?? null,
        appHandle,
        planCheckedAt: new Date(),
      },
    });

    return { ...current({ plan, planHandle: active?.name ?? null, appHandle }), development };
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
    select: { plan: true, planHandle: true, appHandle: true, planTrialEndsAt: true },
  });

  return current(settings ?? { plan: "NONE" });
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
    subscriptionName: settings?.planHandle ?? null,
    trialEndsAt: settings?.planTrialEndsAt ?? null,
    pricingPageUrl: pricingPageUrl(settings?.appHandle),
    has(feature) {
      return Boolean(plan?.features.includes(feature));
    },
  };
}

/**
 * Deep link to the page Shopify hosts for picking a plan.
 *
 * Embedded apps move around the admin with the shopify: protocol rather than a full
 * admin.shopify.com URL: that is what App Bridge supports from inside the frame, and it
 * resolves the current store itself, so there is no store handle to get wrong. Use it
 * with target="_top" so the admin navigates rather than the iframe.
 */
export function pricingPageUrl(appHandle) {
  // eslint-disable-next-line no-undef
  const handle = appHandle || process.env.SHOPIFY_APP_HANDLE;
  return handle ? `shopify://admin/charges/${handle}/pricing_plans` : null;
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

  const { planThatUnlocks } = await import("../utils/plans");
  const needed = planThatUnlocks(feature);

  return {
    error: plan.subscribed
      ? `That's part of the ${needed.name} plan. Change plan to switch it on.`
      : "Pick a plan to switch this on.",
  };
}
