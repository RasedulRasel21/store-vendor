-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "plan" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "planCheckedAt" TIMESTAMP(3),
ADD COLUMN     "planHandle" TEXT,
ADD COLUMN     "planTrialEndsAt" TIMESTAMP(3);

