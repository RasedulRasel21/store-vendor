-- AlterTable
ALTER TABLE "Payout" ADD COLUMN     "fxRate" DECIMAL(18,8),
ADD COLUMN     "payoutAmount" DECIMAL(14,2),
ADD COLUMN     "payoutCurrency" TEXT;

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "payoutFxEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "payoutFxRates" JSONB;

