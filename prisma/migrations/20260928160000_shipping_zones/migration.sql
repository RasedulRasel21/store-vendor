-- Shipping rates were a flat list, each carrying its own countries. They become zones
-- holding options, the way Shopify itself is shaped. Written by hand rather than
-- generated, so rates a vendor has already set are carried across instead of dropped.

-- 1. The new zone table.
CREATE TABLE "VendorShippingZone" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "countryCodes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorShippingZone_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VendorShippingZone_vendorId_idx" ON "VendorShippingZone"("vendorId");

ALTER TABLE "VendorShippingZone"
  ADD CONSTRAINT "VendorShippingZone_vendorId_fkey"
  FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. One zone per vendor per distinct set of countries, which is exactly how these rates
--    were already being grouped when they were pushed to Shopify.
INSERT INTO "VendorShippingZone" ("id", "shop", "vendorId", "name", "countryCodes", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  d."shop",
  d."vendorId",
  CASE
    WHEN cardinality(d."countryCodes") = 0 THEN 'Everywhere else'
    ELSE array_to_string(d."countryCodes", ', ')
  END,
  d."countryCodes",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT "shop", "vendorId", "countryCodes" FROM "VendorShippingRate"
) AS d;

-- 3. Point every existing rate at its zone.
ALTER TABLE "VendorShippingRate" ADD COLUMN "zoneId" TEXT;
ALTER TABLE "VendorShippingRate" ADD COLUMN "transitTime" TEXT;

UPDATE "VendorShippingRate" AS r
SET "zoneId" = z."id"
FROM "VendorShippingZone" AS z
WHERE z."vendorId" = r."vendorId"
  AND z."shop" = r."shop"
  AND z."countryCodes" = r."countryCodes";

-- Nothing should be left over, but a rate with no zone would break the constraint below
-- and it is not worth keeping.
DELETE FROM "VendorShippingRate" WHERE "zoneId" IS NULL;

ALTER TABLE "VendorShippingRate" ALTER COLUMN "zoneId" SET NOT NULL;

-- 4. The countries, shop and vendor now live on the zone.
DROP INDEX IF EXISTS "VendorShippingRate_vendorId_idx";
ALTER TABLE "VendorShippingRate" DROP COLUMN "shop";
ALTER TABLE "VendorShippingRate" DROP COLUMN "vendorId";
ALTER TABLE "VendorShippingRate" DROP COLUMN "countryCodes";

CREATE INDEX "VendorShippingRate_zoneId_idx" ON "VendorShippingRate"("zoneId");

ALTER TABLE "VendorShippingRate"
  ADD CONSTRAINT "VendorShippingRate_zoneId_fkey"
  FOREIGN KEY ("zoneId") REFERENCES "VendorShippingZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;
