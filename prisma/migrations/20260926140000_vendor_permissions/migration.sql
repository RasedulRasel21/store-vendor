-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "autoApproveProducts" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canCreateProducts" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "canSeeCustomerContact" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "productLimit" INTEGER NOT NULL DEFAULT 0;

