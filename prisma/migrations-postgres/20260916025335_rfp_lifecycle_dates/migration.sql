-- AlterTable
ALTER TABLE "Opportunity" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decisionExpectedAt" TIMESTAMP(3),
ADD COLUMN     "submittedAt" TIMESTAMP(3);
