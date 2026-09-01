-- Unique storage for Xboard incremental-sync Idempotency-Key claims.
-- Checked inside the same write transaction as Product/Offer updates.

CREATE TABLE "ExternalCatalogSyncIdempotency" (
  "id" SERIAL NOT NULL,
  "provider" TEXT NOT NULL,
  "productId" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ExternalCatalogSyncIdempotency_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalCatalogSyncIdempotency_provider_idempotencyKey_key"
  ON "ExternalCatalogSyncIdempotency"("provider", "idempotencyKey");

CREATE INDEX "ExternalCatalogSyncIdempotency_productId_idx"
  ON "ExternalCatalogSyncIdempotency"("productId");

ALTER TABLE "ExternalCatalogSyncIdempotency"
  ADD CONSTRAINT "ExternalCatalogSyncIdempotency_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
