-- CreateTable
CREATE TABLE "VendorReturn" (
    "id" TEXT NOT NULL,
    "vendorOrderId" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorReturn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorReturn_vendorOrderId_idx" ON "VendorReturn"("vendorOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorReturn_vendorOrderId_returnId_key" ON "VendorReturn"("vendorOrderId", "returnId");

-- AddForeignKey
ALTER TABLE "VendorReturn" ADD CONSTRAINT "VendorReturn_vendorOrderId_fkey" FOREIGN KEY ("vendorOrderId") REFERENCES "VendorOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

