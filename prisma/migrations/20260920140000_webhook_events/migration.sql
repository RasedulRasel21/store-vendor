-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookEvent_receivedAt_idx" ON "WebhookEvent"("receivedAt");

