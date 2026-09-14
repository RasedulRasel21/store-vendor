-- AlterTable
ALTER TABLE "VendorUser" ADD COLUMN     "passwordHash" TEXT;

-- CreateTable
CREATE TABLE "VendorSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "vendorUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VendorSession_tokenHash_key" ON "VendorSession"("tokenHash");

-- CreateIndex
CREATE INDEX "VendorSession_vendorUserId_idx" ON "VendorSession"("vendorUserId");

-- AddForeignKey
ALTER TABLE "VendorSession" ADD CONSTRAINT "VendorSession_vendorUserId_fkey" FOREIGN KEY ("vendorUserId") REFERENCES "VendorUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

