-- CreateEnum
CREATE TYPE "ProductSubmissionStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "ProductSubmission" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "submittedById" TEXT,
    "status" "ProductSubmissionStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "productType" TEXT,
    "tags" TEXT[],
    "price" DECIMAL(12,2),
    "compareAtPrice" DECIMAL(12,2),
    "sku" TEXT,
    "barcode" TEXT,
    "inventoryQuantity" INTEGER,
    "imageUrls" TEXT[],
    "productId" TEXT,
    "reviewNote" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductSubmission_shop_status_idx" ON "ProductSubmission"("shop", "status");

-- CreateIndex
CREATE INDEX "ProductSubmission_vendorId_status_idx" ON "ProductSubmission"("vendorId", "status");

-- AddForeignKey
ALTER TABLE "ProductSubmission" ADD CONSTRAINT "ProductSubmission_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

