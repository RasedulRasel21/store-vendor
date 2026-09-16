-- CreateEnum
CREATE TYPE "CarrierStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "countryCode" TEXT;

-- CreateTable
CREATE TABLE "ShopCarrier" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trackingUrlTemplate" TEXT,
    "status" "CarrierStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "reviewNote" TEXT,
    "requestedByVendorId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopCarrier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopCarrier_shop_status_idx" ON "ShopCarrier"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ShopCarrier_shop_name_key" ON "ShopCarrier"("shop", "name");

