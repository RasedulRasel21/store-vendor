-- CreateEnum
CREATE TYPE "PayoutMethod" AS ENUM ('BANK', 'BKASH', 'NAGAD', 'ROCKET');

-- CreateEnum
CREATE TYPE "ChangeRequestType" AS ENUM ('PAYOUT');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "addressLine1" TEXT,
ADD COLUMN     "addressLine2" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "countryCode" TEXT,
ADD COLUMN     "payoutDetails" JSONB,
ADD COLUMN     "payoutMethod" "PayoutMethod",
ADD COLUMN     "payoutUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "postalCode" TEXT;

-- CreateTable
CREATE TABLE "VendorChangeRequest" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "type" "ChangeRequestType" NOT NULL,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requested" JSONB NOT NULL,
    "previous" JSONB,
    "requestedById" TEXT,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorChangeRequest_shop_status_idx" ON "VendorChangeRequest"("shop", "status");

-- CreateIndex
CREATE INDEX "VendorChangeRequest_vendorId_type_status_idx" ON "VendorChangeRequest"("vendorId", "type", "status");

-- AddForeignKey
ALTER TABLE "VendorChangeRequest" ADD CONSTRAINT "VendorChangeRequest_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

