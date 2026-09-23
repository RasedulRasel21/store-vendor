-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "payoutFxAuto" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "payoutFxBase" TEXT,
ADD COLUMN     "payoutFxRatesAt" TIMESTAMP(3),
ADD COLUMN     "payoutFxSource" TEXT;

