-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "payoutSchedule" TEXT NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "refundKeepsCommission" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "VendorOrder" ADD COLUMN     "refundKeepsCommission" BOOLEAN NOT NULL DEFAULT false;

