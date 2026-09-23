import { authenticate } from "../shopify.server";
import { formForShop, submitApplicationForShop } from "../models/application.server";
import { page, thanks } from "../models/apply-page.server";

// "Sell with us", served from the merchant's own domain and rendered inside their own
// theme, so somebody handing over their name and email never leaves the shop they were
// looking at. Shopify signs every request that reaches here; an unsigned one is refused
// by authenticate.public.appProxy before any of this runs.

export const loader = async ({ request }) => {
  const { liquid, session } = await authenticate.public.appProxy(request);
  if (!session) return new Response("Not found", { status: 404 });

  const form = await formForShop(session.shop);
  if (!form) return new Response("Not found", { status: 404 });

  return liquid(page(form));
};

export const action = async ({ request }) => {
  const { liquid, session } = await authenticate.public.appProxy(request);
  if (!session) return new Response("Not found", { status: 404 });

  const form = await formForShop(session.shop);
  if (!form) return new Response("Not found", { status: 404 });

  const formData = await request.formData();
  const read = (name) => String(formData.get(name) ?? "").trim();
  const values = {
    name: read("name"),
    contactName: read("contactName"),
    email: read("email"),
    phone: read("phone"),
    countryCode: read("countryCode"),
    website: read("website"),
    sells: read("sells"),
    catalogueSize: read("catalogueSize"),
    message: read("message"),
    agreedTerms: formData.get("agreedTerms") === "on",
    website2: read("website2"),
  };

  const startedAt = Number(read("startedAt"));
  const result = await submitApplicationForShop(session.shop, values, {
    // Shopify passes the visitor's address on, and it's only ever hashed from here.
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    elapsedMs: Number.isFinite(startedAt) && startedAt > 0 ? Date.now() - startedAt : undefined,
  });

  if (result.errors) return liquid(page(form, { errors: result.errors, values }));
  if (result.error) return liquid(page(form, { values, message: result.error }));
  return liquid(thanks(form));
};
