import { runHealthCheck } from "../models/health.server";

// The door an outside monitor knocks on. Open, because a monitor can't carry a secret, so
// it answers "up" or "down" and nothing that would be worth knowing to anyone else.
//
// Point UptimeRobot, Better Stack, Pingdom or the host's own checker at /health and treat
// any status other than 200 as down. Each knock is written down, so the history shows up on
// the app's health page too.
export const loader = async () => {
  const { ok, checks } = await runHealthCheck();

  return Response.json(
    {
      ok,
      app: { ok: checks.database.ok, ms: checks.database.ms },
      portal: { ok: checks.portal.ok, ms: checks.portal.ms },
      time: new Date().toISOString(),
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
};
