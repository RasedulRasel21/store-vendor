-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('SALE', 'REFUND', 'CANCELLATION', 'ADJUSTMENT', 'PAYOUT', 'PAYOUT_REVERSAL');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('REQUESTED', 'PENDING', 'PAID', 'FAILED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PayoutMethod" ADD VALUE 'UPI';
ALTER TYPE "PayoutMethod" ADD VALUE 'MPESA';
ALTER TYPE "PayoutMethod" ADD VALUE 'PAYPAL';
ALTER TYPE "PayoutMethod" ADD VALUE 'PAYONEER';
ALTER TYPE "PayoutMethod" ADD VALUE 'WISE';
ALTER TYPE "PayoutMethod" ADD VALUE 'OTHER';

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "payoutHoldDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "payoutMinimum" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "payoutRequests" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "vendorOrderId" TEXT,
    "orderName" TEXT,
    "payoutId" TEXT,
    "description" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "method" "PayoutMethod",
    "details" JSONB,
    "reference" TEXT,
    "note" TEXT,
    "requestedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerEntry_shop_vendorId_createdAt_idx" ON "LedgerEntry"("shop", "vendorId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_vendorOrderId_idx" ON "LedgerEntry"("vendorOrderId");

-- CreateIndex
CREATE INDEX "LedgerEntry_payoutId_idx" ON "LedgerEntry"("payoutId");

-- CreateIndex
CREATE INDEX "Payout_shop_status_idx" ON "Payout"("shop", "status");

-- CreateIndex
CREATE INDEX "Payout_vendorId_createdAt_idx" ON "Payout"("vendorId", "createdAt");

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_vendorOrderId_fkey" FOREIGN KEY ("vendorOrderId") REFERENCES "VendorOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

