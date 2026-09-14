-- CreateEnum
CREATE TYPE "ShippingMode" AS ENUM ('VENDOR_SHIPS', 'STORE_SHIPS');

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "codEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "codMaxOrderValue" DECIMAL(12,2),
ADD COLUMN     "shippingMode" "ShippingMode" NOT NULL DEFAULT 'VENDOR_SHIPS';

