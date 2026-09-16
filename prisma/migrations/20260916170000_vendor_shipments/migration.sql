-- AlterEnum
ALTER TYPE "VendorOrderStatus" ADD VALUE 'PARTIAL';

-- AlterTable
ALTER TABLE "VendorOrderLine" ADD COLUMN     "shippedQuantity" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "VendorShipment" (
    "id" TEXT NOT NULL,
    "vendorOrderId" TEXT NOT NULL,
    "fulfillmentId" TEXT,
    "trackingCompany" TEXT,
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "items" JSONB NOT NULL,
    "shippedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorShipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorShipment_vendorOrderId_idx" ON "VendorShipment"("vendorOrderId");

-- CreateIndex
CREATE INDEX "VendorShipment_fulfillmentId_idx" ON "VendorShipment"("fulfillmentId");

-- AddForeignKey
ALTER TABLE "VendorShipment" ADD CONSTRAINT "VendorShipment_vendorOrderId_fkey" FOREIGN KEY ("vendorOrderId") REFERENCES "VendorOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

