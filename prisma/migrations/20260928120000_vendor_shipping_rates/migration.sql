-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "vendorShippingRates" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "deliveryProfileId" TEXT;

-- CreateTable
CREATE TABLE "VendorShippingRate" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "countryCodes" TEXT[],
    "price" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorShippingRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorShippingRate_vendorId_idx" ON "VendorShippingRate"("vendorId");

-- AddForeignKey
ALTER TABLE "VendorShippingRate" ADD CONSTRAINT "VendorShippingRate_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

