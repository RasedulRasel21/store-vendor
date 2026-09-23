-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "applyHandle" TEXT,
ADD COLUMN     "applyIntro" TEXT,
ADD COLUMN     "applyOpen" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "applyTermsUrl" TEXT;

-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "applicantHash" TEXT,
ADD COLUMN     "application" JSONB,
ADD COLUMN     "appliedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_applyHandle_key" ON "ShopSettings"("applyHandle");

