-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "taxIdEncrypted" TEXT,
ADD COLUMN     "taxInfo" JSONB,
ADD COLUMN     "taxInfoUpdatedAt" TIMESTAMP(3);

