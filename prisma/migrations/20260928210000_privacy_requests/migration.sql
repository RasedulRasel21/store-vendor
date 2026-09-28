-- CreateTable
CREATE TABLE "PrivacyRequest" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "customerId" TEXT,
    "customerEmail" TEXT,
    "requestId" TEXT,
    "data" JSONB,
    "summary" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PrivacyRequest_shop_receivedAt_idx" ON "PrivacyRequest"("shop", "receivedAt");

