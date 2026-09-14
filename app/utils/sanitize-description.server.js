import sanitizeHtml from "sanitize-html";

// The rich text the vendor portal editor can produce. Anything else is stripped
// before it's shown in the admin or sent to Shopify.
const OPTIONS = {
  allowedTags: ["p", "br", "strong", "b", "em", "i", "u", "s", "a", "ul", "ol", "li", "h2", "h3", "h4", "blockquote"],
  allowedAttributes: { a: ["href", "target", "rel"] },
  allowedSchemes: ["http", "https", "mailto"],
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }),
  },
};

export function sanitizeDescription(html) {
  return html ? sanitizeHtml(html, OPTIONS) : "";
}
