-- AlterTable
ALTER TABLE "ProductSubmission" ADD COLUMN     "collectionIds" TEXT[],
ADD COLUMN     "descriptionHtml" TEXT,
ADD COLUMN     "handle" TEXT,
ADD COLUMN     "options" JSONB,
ADD COLUMN     "seoDescription" TEXT,
ADD COLUMN     "seoTitle" TEXT,
ADD COLUMN     "trackInventory" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "variants" JSONB;

