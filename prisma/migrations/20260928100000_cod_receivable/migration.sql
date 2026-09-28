-- AlterEnum
ALTER TYPE "LedgerEntryType" ADD VALUE 'COD_COLLECTED';

-- AlterTable
ALTER TABLE "VendorOrder" ADD COLUMN     "cashCollectedAt" TIMESTAMP(3),
ADD COLUMN     "cashCollectedBy" TEXT,
ADD COLUMN     "cashOnDelivery" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paymentGateway" TEXT,
ADD COLUMN     "refundedTax" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "tax" DECIMAL(12,2) NOT NULL DEFAULT 0;

