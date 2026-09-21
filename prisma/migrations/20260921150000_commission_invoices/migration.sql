-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "autoInvoices" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "businessAddress" TEXT,
ADD COLUMN     "businessName" TEXT,
ADD COLUMN     "businessTaxId" TEXT,
ADD COLUMN     "commissionTaxRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "invoicePrefix" TEXT NOT NULL DEFAULT 'SV-',
ADD COLUMN     "taxLabel" TEXT NOT NULL DEFAULT 'VAT';

-- CreateTable
CREATE TABLE "CommissionInvoice" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "net" DECIMAL(12,2) NOT NULL,
    "taxLabel" TEXT NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL,
    "taxAmount" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "lines" JSONB NOT NULL,
    "seller" JSONB NOT NULL,
    "buyer" JSONB NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommissionInvoice_vendorId_issuedAt_idx" ON "CommissionInvoice"("vendorId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionInvoice_shop_number_key" ON "CommissionInvoice"("shop", "number");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionInvoice_shop_vendorId_periodStart_key" ON "CommissionInvoice"("shop", "vendorId", "periodStart");

-- AddForeignKey
ALTER TABLE "CommissionInvoice" ADD CONSTRAINT "CommissionInvoice_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

