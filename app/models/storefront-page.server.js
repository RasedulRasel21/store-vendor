import { COUNTRY_NAMES } from "../utils/countries";

// The vendor directory and a single vendor's page, as HTML handed to the theme. Built by
// hand like the application page, so everything a vendor typed is escaped on the way out,
// and styled only where the theme can't know what to do: the grid, the banner's shape,
// the space between things. Type and colour come from the shop.

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Vendors write in a plain textarea, so line breaks are all the formatting there is.
function paragraphs(text) {
  return String(text ?? "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replaceAll("\n", "<br>")}</p>`)
    .join("");
}

const STYLES = `
<style>
  .sv-store { padding: 2rem 1.25rem 3rem; }
  .sv-store__inner { max-width: 60rem; margin-inline: auto; }
  .sv-store__heading { margin: 0 0 .5rem; font-size: clamp(1.6rem, 4vw, 2.4rem); line-height: 1.15; overflow-wrap: break-word; }
  .sv-store__lede { margin: 0 0 2rem; opacity: .8; }

  .sv-store__grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); list-style: none; margin: 0; padding: 0; }
  .sv-store__card { height: 100%; display: flex; gap: .9rem; align-items: flex-start; padding: 1rem; border: 1px solid; border-color: color-mix(in srgb, currentColor 18%, transparent); border-radius: .6rem; color: inherit; text-decoration: none; }
  .sv-store__card:hover { border-color: color-mix(in srgb, currentColor 45%, transparent); }
  .sv-store__avatar { flex: 0 0 auto; width: 3rem; height: 3rem; border-radius: 50%; object-fit: cover; background: color-mix(in srgb, currentColor 10%, transparent); }
  .sv-store__avatar--letter { display: flex; align-items: center; justify-content: center; font-weight: 700; }
  .sv-store__card-name { font-weight: 600; overflow-wrap: break-word; }
  .sv-store__card-blurb { margin: .2rem 0 0; font-size: .9em; opacity: .75; }
  .sv-store__count { margin: .35rem 0 0; font-size: .8em; opacity: .6; }

  .sv-store__banner { width: 100%; aspect-ratio: 4 / 1; object-fit: cover; border-radius: .6rem; margin-bottom: 1.25rem; }
  .sv-store__head { display: flex; gap: 1rem; align-items: center; margin-bottom: 1.5rem; }
  .sv-store__head .sv-store__avatar { width: 4.5rem; height: 4.5rem; font-size: 1.5rem; }
  .sv-store__where { margin: .2rem 0 0; opacity: .7; }
  .sv-store__bio { max-width: 42rem; }
  .sv-store__policies { display: grid; gap: 1.5rem; margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid; border-color: color-mix(in srgb, currentColor 18%, transparent); }
  @media (min-width: 40rem) { .sv-store__policies { grid-template-columns: 1fr 1fr; } }
  .sv-store__policies h2 { font-size: 1.05rem; margin: 0 0 .4rem; }
  .sv-store__actions { margin: 1.5rem 0; }
  .sv-store__button { display: inline-block; padding: .8rem 1.5rem; border: 2px solid currentColor; border-radius: .4rem; font-weight: 700; text-decoration: none; color: inherit; }
  .sv-store__button:hover { opacity: .8; }
  .sv-store__empty { opacity: .75; }
  .sv-store__back { display: inline-block; margin-bottom: 1rem; font-size: .9em; opacity: .75; color: inherit; }
</style>`;

// A circle with their logo, or their initial when they haven't added one.
function avatar(vendor, className = "sv-store__avatar") {
  if (vendor.logoUrl) {
    return `<img class="${className}" src="${escapeHtml(vendor.logoUrl)}" alt="" loading="lazy" width="72" height="72">`;
  }
  const initial = escapeHtml((vendor.name || "?").trim().charAt(0).toUpperCase());
  return `<span class="${className} ${className}--letter" aria-hidden="true">${initial}</span>`;
}

export function directoryPage(vendors, { heading = "Our sellers", intro } = {}) {
  const lede = intro
    ? `<p class="sv-store__lede">${escapeHtml(intro)}</p>`
    : `<p class="sv-store__lede">The independent sellers whose products you'll find here.</p>`;

  const body = vendors.length
    ? `<ul class="sv-store__grid">${vendors
        .map(
          (vendor) => `
      <li><a class="sv-store__card" href="/apps/vendors/${escapeHtml(vendor.handle)}">
        ${avatar(vendor)}
        <span>
          <span class="sv-store__card-name">${escapeHtml(vendor.name)}</span>
          ${vendor.blurb ? `<span class="sv-store__card-blurb">${escapeHtml(vendor.blurb)}</span>` : ""}
          <span class="sv-store__count">${vendor.productCount} ${vendor.productCount === 1 ? "product" : "products"}</span>
        </span>
      </a></li>`,
        )
        .join("")}</ul>`
    : `<p class="sv-store__empty">No sellers are listed yet. Check back soon.</p>`;

  return `${STYLES}
    <div class="sv-store"><div class="sv-store__inner">
      <h1 class="sv-store__heading">${escapeHtml(heading)}</h1>
      ${lede}
      ${body}
    </div></div>`;
}

export function vendorStorePage(vendor) {
  const where = vendor.countryCode ? COUNTRY_NAMES[vendor.countryCode] : null;
  const count = vendor.productCount;

  return `${STYLES}
    <div class="sv-store"><div class="sv-store__inner">
      <a class="sv-store__back" href="/apps/vendors">← All sellers</a>
      ${vendor.bannerUrl ? `<img class="sv-store__banner" src="${escapeHtml(vendor.bannerUrl)}" alt="" loading="lazy">` : ""}

      <div class="sv-store__head">
        ${avatar(vendor)}
        <div>
          <h1 class="sv-store__heading" style="margin-bottom:0">${escapeHtml(vendor.name)}</h1>
          ${where ? `<p class="sv-store__where">${escapeHtml(where)}</p>` : ""}
        </div>
      </div>

      ${vendor.bio ? `<div class="sv-store__bio">${paragraphs(vendor.bio)}</div>` : ""}

      <div class="sv-store__actions">
        ${
          count
            ? `<a class="sv-store__button" href="${escapeHtml(vendor.productsUrl)}">Shop ${count} ${count === 1 ? "product" : "products"}</a>`
            : `<p class="sv-store__empty">Nothing for sale here just yet.</p>`
        }
      </div>

      ${
        vendor.shippingPolicy || vendor.returnPolicy
          ? `<div class="sv-store__policies">
              ${vendor.shippingPolicy ? `<div><h2>Shipping</h2>${paragraphs(vendor.shippingPolicy)}</div>` : ""}
              ${vendor.returnPolicy ? `<div><h2>Returns</h2>${paragraphs(vendor.returnPolicy)}</div>` : ""}
            </div>`
          : ""
      }
    </div></div>`;
}
