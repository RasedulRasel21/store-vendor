-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "payoutChangeHoldEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "payoutChangeHoldHours" INTEGER NOT NULL DEFAULT 48;

