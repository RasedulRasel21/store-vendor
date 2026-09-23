import crypto from "node:crypto";
import { publicForm, submitApplication } from "../models/application.server";

// The vendor portal renders the "sell with us" form; the app owns what happens to it, the
// same way it owns everything else the portal can't do for itself. The portal calls this
// from its own server with the shared secret, so the request is trusted to say which
// address it came from.
function authorized(request) {
  // eslint-disable-next-line no-undef
  const secret = process.env.PORTAL_SYNC_SECRET;
  const provided = request.headers.get("x-storevendor-secret") ?? "";
  if (!secret || provided.length !== secret.length) return false;

  // eslint-disable-next-line no-undef
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
}

const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  if (!authorized(request)) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const handle = text(body?.handle, 80);
  const intent = text(body?.intent, 20);
  if (!handle) return Response.json({ error: "Missing store" }, { status: 400 });

  if (intent === "form") {
    const form = await publicForm(handle);
    if (!form) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(form);
  }

  if (intent === "submit") {
    const result = await submitApplication(handle, body?.application ?? {}, {
      ip: text(body?.ip, 60) || null,
      elapsedMs: typeof body?.elapsedMs === "number" ? body.elapsedMs : undefined,
    });
    if (result.errors) return Response.json({ errors: result.errors }, { status: 422 });
    if (result.error) return Response.json({ error: result.error }, { status: result.closed ? 409 : 400 });
    // Whether it was really recorded, quietly ignored or a repeat, the sender is told the
    // same thing: that the store has it.
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
};
