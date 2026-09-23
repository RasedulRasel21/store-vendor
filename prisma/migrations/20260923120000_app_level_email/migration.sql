-- AlterTable
ALTER TABLE "ShopSettings" DROP COLUMN "emailApiKey",
DROP COLUMN "emailFrom",
DROP COLUMN "emailProvider",
DROP COLUMN "emailReplyTo",
ADD COLUMN     "shopEmail" TEXT,
ADD COLUMN     "shopName" TEXT;

