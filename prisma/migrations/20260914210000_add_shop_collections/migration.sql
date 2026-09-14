-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN     "collectionsSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ShopCollection" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "imageUrl" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopCollection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopCollection_shop_title_idx" ON "ShopCollection"("shop", "title");

-- CreateIndex
CREATE UNIQUE INDEX "ShopCollection_shop_collectionId_key" ON "ShopCollection"("shop", "collectionId");

