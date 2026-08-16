-- FND-CMI-001 F0 migration 3/4: external catalog identity.
--
-- SPEC-CATALOG-OPS-001 §5.4 / §11.1 / §11.2 step 4:
--   * Offer (externalIntegration, externalSku) becomes a DB unique identity.
--     The pre-flight guard below aborts on normalized duplicates instead of
--     silently deleting or merging rows (D-CAT-19 / CAT-016).
--   * ExternalCatalogLink table with UNIQUE(provider, externalProductId) and
--     UNIQUE(provider, idempotencyKey).

-- Preflight: normalized (provider, trim+lowercase sku) duplicates must block
-- the unique constraint. This never silently deletes or merges legacy rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT "externalIntegration", lower(btrim("externalSku")) AS sku
      FROM "Offer"
      WHERE "externalIntegration" IS NOT NULL AND "externalSku" IS NOT NULL
      GROUP BY "externalIntegration", lower(btrim("externalSku"))
      HAVING count(*) > 1
    ) d
  ) THEN
    RAISE EXCEPTION
      'Cannot create Offer external identity unique constraint: normalized duplicate (provider, sku) rows exist. Reconcile before retrying.';
  END IF;
END $$;

-- Reject canonical-empty externalSku (whitespace-only) before canonicalizing;
-- a canonical empty string violates the frozen canonical form and the
-- 20260729150000 non-empty faka_bridge CHECK.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Offer"
    WHERE "externalSku" IS NOT NULL AND btrim("externalSku") = ''
  ) THEN
    RAISE EXCEPTION
      'Cannot canonicalize Offer.externalSku: whitespace-only value present. Reconcile before retrying.';
  END IF;
END $$;

-- Canonicalize every non-empty externalSku to lower(btrim(...)) so the
-- database stores the frozen inbound canonical form (SPEC-CATALOG-OPS-001
-- §5.4). This normalizes case/space; it never deletes or merges rows.
UPDATE "Offer" SET "externalSku" = lower(btrim("externalSku"))
WHERE "externalSku" IS NOT NULL;

-- The old non-unique index (20260729150000) is replaced by the unique index.
DROP INDEX "Offer_externalIntegration_externalSku_idx";

-- CreateIndex (Prisma naming)
CREATE UNIQUE INDEX "Offer_externalIntegration_externalSku_key"
  ON "Offer"("externalIntegration", "externalSku");

-- CreateTable
CREATE TABLE "ExternalCatalogLink" (
    "id" SERIAL NOT NULL,
    "provider" TEXT NOT NULL,
    "externalProductId" TEXT NOT NULL,
    "productId" INTEGER NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "sourceSnapshot" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "importedByUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalCatalogLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalCatalogLink_productId_key" ON "ExternalCatalogLink"("productId");

-- CreateIndex
CREATE INDEX "ExternalCatalogLink_importedByUserId_idx" ON "ExternalCatalogLink"("importedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalCatalogLink_provider_externalProductId_key"
  ON "ExternalCatalogLink"("provider", "externalProductId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalCatalogLink_provider_idempotencyKey_key"
  ON "ExternalCatalogLink"("provider", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "ExternalCatalogLink" ADD CONSTRAINT "ExternalCatalogLink_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalCatalogLink" ADD CONSTRAINT "ExternalCatalogLink_importedByUserId_fkey"
  FOREIGN KEY ("importedByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Raw SQL: external idempotency key/hash format (SPEC-CATALOG-OPS-001 §5.4/§9.3).
ALTER TABLE "ExternalCatalogLink"
  ADD CONSTRAINT "ExternalCatalogLink_idempotencyKey_format_check"
    CHECK ("idempotencyKey" ~ '^[A-Za-z0-9._:-]{1,128}$'),
  ADD CONSTRAINT "ExternalCatalogLink_requestHash_format_check"
    CHECK ("requestHash" ~ '^[0-9a-f]{64}$');
