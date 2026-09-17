-- AlterTable
ALTER TABLE "AiInsight" ADD COLUMN "userId" TEXT;

-- CreateIndex
CREATE INDEX "AiInsight_userId_kind_createdAt_idx" ON "AiInsight"("userId", "kind", "createdAt");
