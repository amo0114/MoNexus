ALTER TABLE "ProductVideoAsset"
  ADD COLUMN "outputGeneration" TEXT,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "processingToken" TEXT,
  ADD COLUMN "processingUntil" TIMESTAMP(3),
  ADD COLUMN "processingError" TEXT,
  ADD COLUMN "moderation" TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN "moderationVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "reviewedById" INTEGER,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "moderationReason" TEXT;
ALTER TABLE "ProductVideoAsset" DROP CONSTRAINT "ProductVideoAsset_status_check";
ALTER TABLE "ProductVideoAsset" ADD CONSTRAINT "ProductVideoAsset_status_check"
  CHECK (status IN ('uploading','queued','processing','ready','failed','deleting'));
ALTER TABLE "ProductVideoAsset" ADD CONSTRAINT "ProductVideoAsset_moderation_check"
  CHECK (moderation IN ('pending','approved','rejected'));
CREATE INDEX "ProductVideoAsset_status_nextAttemptAt_idx" ON "ProductVideoAsset" (status, "nextAttemptAt");
