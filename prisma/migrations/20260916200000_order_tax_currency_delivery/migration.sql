-- AlterTable
ALTER TABLE "VendorOrder" ADD COLUMN     "deliveryMethod" TEXT,
ADD COLUMN     "presentmentCurrency" TEXT,
ADD COLUMN     "presentmentSubtotal" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "VendorOrderLine" ADD COLUMN     "presentmentSubtotal" DECIMAL(12,2),
ADD COLUMN     "requiresShipping" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "weight" DECIMAL(10,3),
ADD COLUMN     "weightUnit" TEXT;

