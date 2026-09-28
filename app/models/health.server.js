import db from "../db.server";

// Is the marketplace up, and was it up last night?
//
// Nothing can watch itself: an app that is down can't report that it is down. So /health is
// the door an outside monitor knocks on — UptimeRobot, Better Stack, the host's own checker,
// whatever is pointed at it. What this module adds is memory. Every knock is written down,
// so the history is here rather than locked inside someone's monitoring account, and the
// merchant can be shown it without an account at all.
//
// One probe covers both halves: the app checks the database it can't work without, and the
// vendor portal, which its sellers can't work without.

const TIMEOUT_MS = 5000;

async function timed(work) {
  const started = Date.now();
  try {
    const detail = await work();
    return { ok: true, ms: Date.now() - started, detail: detail ?? null };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, detail: String(error?.message ?? error).slice(0, 300) };
  }
}

// The cheapest question that still proves a connection, a session and a query.
const checkDatabase = () =>
  timed(async () => {
    await db.$queryRaw`SELECT 1`;
    return null;
  });

const checkPortal = () =>
  timed(async () => {
    // eslint-disable-next-line no-undef
    const base = process.env.VENDOR_PORTAL_URL?.replace(/\/$/, "");
    if (!base) return "not set up";

    const response = await fetch(`${base}/health`, {
      headers: { "User-Agent": "StoreVendor health check" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`answered ${response.status}`);
    return null;
  });

const RECORD_GAP_MS = 30 * 1000;

async function quietEnough() {
  const last = await db.uptimeCheck
    .findFirst({ where: { target: "app" }, orderBy: { checkedAt: "desc" }, select: { checkedAt: true } })
    .catch(() => null);
  return !last || Date.now() - last.checkedAt.getTime() >= RECORD_GAP_MS;
}

/**
 * Runs the checks and writes down what happened. Recording a check must never be the reason
 * a check fails, so a database that is already down simply goes unrecorded.
 */
export async function runHealthCheck({ record = true } = {}) {
  const [database, portal] = await Promise.all([checkDatabase(), checkPortal()]);
  const checks = { database, portal };
  const ok = database.ok && portal.ok;

  // /health has to be open for a monitor to reach it, which means anyone can hit it. One
  // record every half minute is enough for a check that runs every one to five minutes,
  // and stops a bored visitor filling the table.
  if (record && database.ok && (await quietEnough())) {
    await db.uptimeCheck
      .createMany({
        data: [
          { target: "app", ok: true, ms: database.ms },
          { target: "portal", ok: portal.ok, ms: portal.ms, detail: portal.detail },
        ],
      })
      .catch(() => {});
  }

  return { ok, checks };
}

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/**
 * How things have held up. Only as complete as the probes that arrived: with no monitor
 * pointed at /health there is nothing to summarise, which the page says rather than
 * claiming everything is fine.
 */
export async function uptimeSummary({ days = 7 } = {}) {
  const since = daysAgo(days);
  const rows = await db.uptimeCheck.groupBy({
    by: ["target", "ok"],
    where: { checkedAt: { gte: since } },
    _count: { _all: true },
    _avg: { ms: true },
  });

  const latest = await db.uptimeCheck.findMany({
    where: { checkedAt: { gte: since } },
    orderBy: { checkedAt: "desc" },
    distinct: ["target"],
  });

  const lastFailures = await db.uptimeCheck.findMany({
    where: { ok: false, checkedAt: { gte: since } },
    orderBy: { checkedAt: "desc" },
    distinct: ["target"],
  });

  const targets = ["app", "portal"].map((target) => {
    const good = rows.find((row) => row.target === target && row.ok)?._count._all ?? 0;
    const bad = rows.find((row) => row.target === target && !row.ok)?._count._all ?? 0;
    const total = good + bad;
    const averageMs = rows
      .filter((row) => row.target === target)
      .reduce((sum, row) => sum + (row._avg.ms ?? 0) * row._count._all, 0);

    return {
      target,
      checks: total,
      failures: bad,
      // Null rather than a flattering 100% when nothing has been checked.
      percent: total ? Math.round((good / total) * 1000) / 10 : null,
      averageMs: total ? Math.round(averageMs / total) : null,
      lastCheckedAt: latest.find((row) => row.target === target)?.checkedAt ?? null,
      lastFailure: lastFailures.find((row) => row.target === target) ?? null,
    };
  });

  return { days, targets, monitored: targets.some((target) => target.checks > 0) };
}

// A month of probes is plenty to see a pattern in, and at one every five minutes that is
// about nine thousand rows.
const KEEP_DAYS = 30;

export function pruneUptimeChecks() {
  return db.uptimeCheck.deleteMany({ where: { checkedAt: { lt: daysAgo(KEEP_DAYS) } } });
}
