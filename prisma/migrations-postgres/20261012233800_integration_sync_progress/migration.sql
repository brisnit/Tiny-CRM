-- AlterTable
ALTER TABLE "Integration" ADD COLUMN     "backfillTruncated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "importedThrough" TIMESTAMP(3),
ADD COLUMN     "pagesImported" INTEGER NOT NULL DEFAULT 0;

