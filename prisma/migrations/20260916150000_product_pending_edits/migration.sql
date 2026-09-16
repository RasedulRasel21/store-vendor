-- AlterTable
ALTER TABLE "ProductSubmission" ADD COLUMN     "pendingDraft" JSONB,
ADD COLUMN     "pendingReviewNote" TEXT,
ADD COLUMN     "pendingSubmittedAt" TIMESTAMP(3);

