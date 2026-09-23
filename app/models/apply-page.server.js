// The "sell with us" page as HTML, for the copy served from the merchant's own domain
// through the app proxy. It's built by hand rather than rendered, so every piece of text
// that came from a merchant or an applicant is escaped on the way out. It lives apart from
// the route because a route may only export what React Router knows how to strip from the
// browser bundle.
import { CATALOGUE_SIZES } from "./application.server";
import { COUNTRY_NAMES } from "../utils/countries";

const PATH = "/apps/vendors/apply";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// The theme owns the look of the page. This is only the handful of rules a theme can't
// know about: the width of the form and the space between its fields.
const STYLES = `
<style>
  .sv-apply { max-width: 42rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
  .sv-apply__intro { margin: 0 0 2rem; }
  .sv-apply__field { margin-bottom: 1.25rem; }
  .sv-apply__field label { display: block; margin-bottom: .35rem; font-weight: 600; }
  .sv-apply__field input, .sv-apply__field select, .sv-apply__field textarea {
    width: 100%; padding: .65rem .75rem; border: 1px solid currentColor; border-radius: .4rem;
    background: transparent; color: inherit; font: inherit; opacity: .95;
  }
  .sv-apply__hint { display: block; margin-top: .35rem; font-size: .875rem; opacity: .7; }
  .sv-apply__error { margin-top: .35rem; font-size: .875rem; color: #b42318; }
  .sv-apply__row { display: grid; gap: 1.25rem; }
  @media (min-width: 40rem) { .sv-apply__row { grid-template-columns: 1fr 1fr; } }
  .sv-apply__terms { display: flex; gap: .6rem; align-items: flex-start; margin: 1.5rem 0; }
  .sv-apply__terms input { width: auto; margin-top: .25rem; }
  /* Bordered rather than filled: a theme's own colours are unknown here, and a button that
     borrows the text colour for both its background and its text can end up invisible. */
  .sv-apply__button {
    display: inline-block; width: 100%; padding: .8rem 1.25rem; border-radius: .4rem;
    border: 2px solid currentColor; background: transparent; color: inherit;
    font: inherit; font-weight: 700; cursor: pointer;
  }
  .sv-apply__button:hover { opacity: .8; }
  .sv-apply__note { margin-top: 2rem; font-size: .9rem; opacity: .7; }
  .sv-apply__banner { padding: .85rem 1rem; border-radius: .4rem; border: 1px solid #b42318; color: #b42318; margin-bottom: 1.5rem; }
  .sv-apply--done { text-align: center; padding: 4rem 1.25rem; }
  .sv-apply__hidden { position: absolute; left: -9999px; }
</style>`;

function field({ name, label, hint, error, value = "", type = "text", required, attrs = "" }) {
  return `
    <div class="sv-apply__field">
      <label for="${name}">${escapeHtml(label)}</label>
      <input id="${name}" name="${name}" type="${type}" value="${escapeHtml(value)}"
        ${required ? "required" : ""} ${attrs}>
      ${hint && !error ? `<span class="sv-apply__hint">${escapeHtml(hint)}</span>` : ""}
      ${error ? `<p class="sv-apply__error">${escapeHtml(error)}</p>` : ""}
    </div>`;
}

function textarea({ name, label, hint, error, value = "", rows = 3, maxLength, required }) {
  return `
    <div class="sv-apply__field">
      <label for="${name}">${escapeHtml(label)}</label>
      <textarea id="${name}" name="${name}" rows="${rows}" maxlength="${maxLength}" ${required ? "required" : ""}>${escapeHtml(value)}</textarea>
      ${hint && !error ? `<span class="sv-apply__hint">${escapeHtml(hint)}</span>` : ""}
      ${error ? `<p class="sv-apply__error">${escapeHtml(error)}</p>` : ""}
    </div>`;
}

function select({ name, label, options, value = "", placeholder, error, required }) {
  const choices = options
    .map(
      (option) =>
        `<option value="${escapeHtml(option.value)}"${option.value === value ? " selected" : ""}>${escapeHtml(option.label)}</option>`,
    )
    .join("");
  return `
    <div class="sv-apply__field">
      <label for="${name}">${escapeHtml(label)}</label>
      <select id="${name}" name="${name}" ${required ? "required" : ""}>
        <option value="">${escapeHtml(placeholder)}</option>
        ${choices}
      </select>
      ${error ? `<p class="sv-apply__error">${escapeHtml(error)}</p>` : ""}
    </div>`;
}

export function page(form, { errors = {}, values = {}, message } = {}) {
  const storeName = escapeHtml(form.storeName);

  if (!form.open) {
    return `${STYLES}
      <div class="sv-apply">
        <h1>Sell with ${storeName}</h1>
        <p class="sv-apply__intro">We're not taking new sellers just now. It's worth checking back.</p>
      </div>`;
  }

  const countries = Object.entries(COUNTRY_NAMES).map(([value, label]) => ({ value, label }));
  const terms = form.termsUrl
    ? `I accept <a href="${escapeHtml(form.termsUrl)}" target="_blank" rel="noreferrer">${storeName}'s seller terms</a>.`
    : `I agree to ${storeName} getting in touch about selling with them.`;

  return `${STYLES}
    <div class="sv-apply">
      <h1>Sell with ${storeName}</h1>
      <p class="sv-apply__intro">${escapeHtml(
        form.intro ??
          `Apply to sell your products through ${form.storeName}. Tell us who you are and what you make, and we'll be in touch.`,
      )}</p>

      ${message ? `<p class="sv-apply__banner">${escapeHtml(message)}</p>` : ""}

      <form method="post" action="${PATH}">
        <div class="sv-apply__hidden" aria-hidden="true">
          <label for="website2">Leave this empty</label>
          <input id="website2" name="website2" type="text" tabindex="-1" autocomplete="off">
        </div>
        <input type="hidden" name="startedAt" id="sv-started">

        ${field({
          name: "name",
          label: "What do you sell under?",
          hint: "The name customers will see.",
          value: values.name,
          error: errors.name,
          required: true,
          attrs: 'maxlength="80"',
        })}

        <div class="sv-apply__row">
          ${field({ name: "contactName", label: "Your name", value: values.contactName, error: errors.contactName, required: true, attrs: 'maxlength="80" autocomplete="name"' })}
          ${field({ name: "email", label: "Email", type: "email", value: values.email, error: errors.email, required: true, attrs: 'maxlength="120" autocomplete="email"' })}
        </div>

        <div class="sv-apply__row">
          ${field({ name: "phone", label: "Phone (optional)", type: "tel", value: values.phone, error: errors.phone, attrs: 'maxlength="30" autocomplete="tel"' })}
          ${select({ name: "countryCode", label: "Where are you based?", options: countries, value: values.countryCode, placeholder: "Choose a country", error: errors.countryCode, required: true })}
        </div>

        ${textarea({ name: "sells", label: "What would you like to sell?", hint: "A line or two is plenty.", value: values.sells, error: errors.sells, maxLength: 500, required: true })}

        <div class="sv-apply__row">
          ${select({ name: "catalogueSize", label: "Roughly how many products? (optional)", options: CATALOGUE_SIZES, value: values.catalogueSize, placeholder: "Not sure yet", error: errors.catalogueSize })}
          ${field({ name: "website", label: "Website or social page (optional)", type: "url", value: values.website, error: errors.website, hint: "Anywhere they can see your work.", attrs: 'maxlength="200" placeholder="https://"' })}
        </div>

        ${textarea({ name: "message", label: "Anything else (optional)", value: values.message, error: errors.message, maxLength: 1000 })}

        <div class="sv-apply__terms">
          <input id="agreedTerms" name="agreedTerms" type="checkbox" value="on"${values.agreedTerms ? " checked" : ""}>
          <label for="agreedTerms">${terms}</label>
        </div>
        ${errors.agreedTerms ? `<p class="sv-apply__error">${escapeHtml(errors.agreedTerms)}</p>` : ""}

        <button type="submit" class="sv-apply__button"><span>Apply to sell</span></button>
      </form>

      <script>
        document.getElementById("sv-started").value = Date.now();
      </script>
    </div>`;
}

export function thanks(form) {
  return `${STYLES}
    <div class="sv-apply sv-apply--done">
      <h1>Thanks — we have your application</h1>
      <p>Someone at ${escapeHtml(form.storeName)} will read it and get back to you. If they take you
      on, you'll get an email with a link to set up your account and start adding products.</p>
    </div>`;
}
