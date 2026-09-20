-- CreateTable
CREATE TABLE "OrderLineVendor" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "fromVendorId" TEXT,
    "title" TEXT NOT NULL,
    "movedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderLineVendor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderLineVendor_shop_orderId_idx" ON "OrderLineVendor"("shop", "orderId");

-- CreateIndex
CREATE INDEX "OrderLineVendor_vendorId_idx" ON "OrderLineVendor"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLineVendor_shop_orderId_lineItemId_key" ON "OrderLineVendor"("shop", "orderId", "lineItemId");

-- AddForeignKey
ALTER TABLE "OrderLineVendor" ADD CONSTRAINT "OrderLineVendor_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

