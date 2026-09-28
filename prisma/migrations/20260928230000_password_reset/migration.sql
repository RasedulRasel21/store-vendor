-- AlterTable
ALTER TABLE "VendorUser" ADD COLUMN     "resetExpiresAt" TIMESTAMP(3),
ADD COLUMN     "resetTokenHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "VendorUser_resetTokenHash_key" ON "VendorUser"("resetTokenHash");

