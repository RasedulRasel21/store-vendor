-- CreateEnum
CREATE TYPE "VendorOrderStatus" AS ENUM ('OPEN', 'FULFILLED', 'CANCELLED');

-- CreateTable
CREATE TABLE "VendorOrder" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "status" "VendorOrderStatus" NOT NULL DEFAULT 'OPEN',
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "financialStatus" TEXT,
    "customerName" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "shippingAddress" JSONB,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "commission" DECIMAL(12,2) NOT NULL,
    "shipping" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "earnings" DECIMAL(12,2) NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL,
    "fulfilledAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorOrderLine" (
    "id" TEXT NOT NULL,
    "vendorOrderId" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "imageUrl" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "commission" DECIMAL(12,2) NOT NULL,
    "earnings" DECIMAL(12,2) NOT NULL,
    "fulfillmentOrderId" TEXT,
    "fulfillmentOrderLineItemId" TEXT,
    "fulfillableQuantity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "VendorOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorOrder_shop_status_idx" ON "VendorOrder"("shop", "status");

-- CreateIndex
CREATE INDEX "VendorOrder_vendorId_status_idx" ON "VendorOrder"("vendorId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VendorOrder_shop_orderId_vendorId_key" ON "VendorOrder"("shop", "orderId", "vendorId");

-- CreateIndex
CREATE INDEX "VendorOrderLine_vendorOrderId_idx" ON "VendorOrderLine"("vendorOrderId");

-- AddForeignKey
ALTER TABLE "VendorOrder" ADD CONSTRAINT "VendorOrder_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorOrderLine" ADD CONSTRAINT "VendorOrderLine_vendorOrderId_fkey" FOREIGN KEY ("vendorOrderId") REFERENCES "VendorOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

