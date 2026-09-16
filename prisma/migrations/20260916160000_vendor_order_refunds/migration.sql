-- AlterTable
ALTER TABLE "VendorOrder" ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "refunded" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "refundedCommission" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "refundedEarnings" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "VendorOrderLine" ADD COLUMN     "refundedQuantity" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refundedSubtotal" DECIMAL(12,2) NOT NULL DEFAULT 0;

