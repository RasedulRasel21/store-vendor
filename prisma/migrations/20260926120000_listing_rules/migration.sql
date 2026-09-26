-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "bannedWords" TEXT[],
ADD COLUMN     "maxProductsPerVendor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "minProductImages" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "requireDescription" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "requireProductType" BOOLEAN NOT NULL DEFAULT false;

