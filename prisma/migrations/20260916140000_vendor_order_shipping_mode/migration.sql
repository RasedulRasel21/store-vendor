-- AlterTable
ALTER TABLE "VendorOrder" ADD COLUMN     "shippingMode" "ShippingMode" NOT NULL DEFAULT 'VENDOR_SHIPS';


-- Existing vendor orders keep whatever the vendor is set to today.
UPDATE "VendorOrder" o SET "shippingMode" = v."shippingMode" FROM "Vendor" v WHERE v.id = o."vendorId";
