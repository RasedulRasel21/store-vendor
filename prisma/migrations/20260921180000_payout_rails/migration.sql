-- AlterEnum
ALTER TYPE "PayoutMethod" ADD VALUE 'STRIPE';

-- AlterTable
ALTER TABLE "Payout" ADD COLUMN     "provider" TEXT,
ADD COLUMN     "providerRef" TEXT,
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "sentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "autoSendPayouts" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paypalAccount" TEXT,
ADD COLUMN     "paypalCredentials" TEXT,
ADD COLUMN     "paypalMode" TEXT,
ADD COLUMN     "stripeAccount" TEXT,
ADD COLUMN     "stripeSecretKey" TEXT;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "stripeAccountId" TEXT;

