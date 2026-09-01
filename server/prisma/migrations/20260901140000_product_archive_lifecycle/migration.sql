-- Additive Product archive lifecycle. status remains the publish state;
-- archivedAt is the admin recycle-bin flag. Historical business rows are kept.

ALTER TABLE "Product"
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "archivedByUserId" INTEGER,
  ADD COLUMN "archiveReason" TEXT;

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_archivedByUserId_fkey"
  FOREIGN KEY ("archivedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Product_archivedAt_idx" ON "Product"("archivedAt");
