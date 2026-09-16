// Carriers Shopify recognises for tracking. When one of these is used, Shopify builds the
// tracking link itself, so vendors don't have to paste a URL.
// Source: FulfillmentTrackingInfo in the Admin API docs.
const GLOBAL_CARRIERS = [
  "4PX",
  "Amazon Logistics",
  "APC",
  "Aramex",
  "Asendia",
  "Australia Post",
  "Bluedart",
  "Bring",
  "BRT",
  "Canada Post",
  "China Post",
  "Chronopost",
  "Colissimo",
  "Correios",
  "Couriers Please",
  "DHL eCommerce",
  "DHL Express",
  "DHL Parcel",
  "DPD",
  "DTDC",
  "Ecom Express",
  "Evri",
  "FedEx",
  "GLS",
  "Globegistics",
  "Japan Post",
  "La Poste",
  "Newgistics",
  "PostNL",
  "PostNord",
  "Purolator",
  "Royal Mail",
  "Sagawa",
  "Sendle",
  "SF Express",
  "Singapore Post",
  "TNT",
  "Toll IPEC",
  "UPS",
  "USPS",
  "Whistl",
  "Yamato",
  "YunExpress",
];

// Carriers Shopify only shows for shops in that country.
const CARRIERS_BY_COUNTRY = {
  AU: ["Australia Post", "Sendle", "Aramex Australia", "TNT Australia", "Hunter Express", "Couriers Please", "Allied Express", "Direct Couriers", "Northline"],
  AT: ["Österreichische Post"],
  BG: ["Speedy"],
  CA: ["Intelcom", "BoxKnight", "Loomis", "GLS", "Canada Post", "Purolator"],
  CN: ["China Post", "DHL eCommerce Asia", "WanbExpress", "YunExpress", "Anjun Logistics", "SFC Fulfillment"],
  CZ: ["Zásilkovna"],
  DE: ["Deutsche Post", "DHL", "DHL Express", "Hermes", "GLS"],
  ES: ["SEUR", "Correos"],
  FR: ["Colissimo", "Mondial Relay", "Colis Privé", "GLS"],
  GB: ["Evri", "DPD UK", "Parcelforce", "Yodel", "DHL Parcel", "Tuffnells", "Royal Mail"],
  GR: ["ACS Courier"],
  HK: ["SF Express"],
  IE: ["Fastway", "DPD Ireland"],
  IN: ["DTDC", "India Post", "Delhivery", "Gati KWE", "Professional Couriers", "XpressBees", "Ecom Express", "Ekart", "Shadowfax", "Bluedart"],
  IT: ["BRT", "GLS Italy", "Poste Italiane"],
  JP: ["Japan Post", "Yamato", "Sagawa"],
  NL: ["DHL Parcel", "DPD", "PostNL"],
  NO: ["Bring"],
  PL: ["Inpost"],
  TR: ["PTT", "Yurtiçi Kargo", "Aras Kargo", "Sürat Kargo"],
  US: ["USPS", "UPS", "FedEx", "GLS", "Alliance Air Freight", "Pilot Freight", "LSO", "Old Dominion", "Pandion", "R+L Carriers", "Southwest Air Cargo"],
  ZA: ["Fastway", "Skynet"],
};

// The carriers a shop's vendors can choose from, before any the merchant has approved.
// Shopify has no list for some countries (Bangladesh among them), which is why vendors
// can ask for one to be added.
export function shopifyCarriers(countryCode) {
  const local = CARRIERS_BY_COUNTRY[countryCode ?? ""] ?? [];
  return [...new Set([...local, ...GLOBAL_CARRIERS])].sort((a, b) => a.localeCompare(b));
}
