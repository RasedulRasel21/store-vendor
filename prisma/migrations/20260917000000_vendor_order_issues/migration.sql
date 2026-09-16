-- CreateEnum
CREATE TYPE "OrderIssueStatus" AS ENUM ('OPEN', 'RESOLVED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "VendorOrderIssue" (
    "id" TEXT NOT NULL,
    "vendorOrderId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "status" "OrderIssueStatus" NOT NULL DEFAULT 'OPEN',
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "VendorOrderIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorOrderIssue_vendorOrderId_idx" ON "VendorOrderIssue"("vendorOrderId");

-- CreateIndex
CREATE INDEX "VendorOrderIssue_status_idx" ON "VendorOrderIssue"("status");

-- AddForeignKey
ALTER TABLE "VendorOrderIssue" ADD CONSTRAINT "VendorOrderIssue_vendorOrderId_fkey" FOREIGN KEY ("vendorOrderId") REFERENCES "VendorOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

