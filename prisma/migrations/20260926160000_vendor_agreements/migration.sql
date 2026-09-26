-- CreateTable
CREATE TABLE "VendorAgreement" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorAgreementAcceptance" (
    "id" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "vendorUserId" TEXT,
    "signedName" TEXT NOT NULL,
    "signedEmail" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signerHash" TEXT,

    CONSTRAINT "VendorAgreementAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VendorAgreement_shop_publishedAt_idx" ON "VendorAgreement"("shop", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "VendorAgreement_shop_version_key" ON "VendorAgreement"("shop", "version");

-- CreateIndex
CREATE INDEX "VendorAgreementAcceptance_shop_vendorId_idx" ON "VendorAgreementAcceptance"("shop", "vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorAgreementAcceptance_agreementId_vendorId_key" ON "VendorAgreementAcceptance"("agreementId", "vendorId");

-- AddForeignKey
ALTER TABLE "VendorAgreementAcceptance" ADD CONSTRAINT "VendorAgreementAcceptance_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "VendorAgreement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorAgreementAcceptance" ADD CONSTRAINT "VendorAgreementAcceptance_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

