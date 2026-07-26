-- P4a follow-up: make the "default offer" explicit instead of "lowest id".
-- Three previously entangled concepts are now separated:
--   isDefault  -> compat write paths (product-level edit, no-offerId ops)
--   sortOrder  -> public display order
--   min(price) -> the projected "from" price on listings
-- Backfill marks each product's lowest-id offer (exactly the row the P4a
-- backfill created for pre-SKU products). The partial unique index makes
-- "at most one default per product" a database-level invariant.

ALTER TABLE "Offer" ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Offer" o
SET "isDefault" = true
WHERE o."id" = (
  SELECT MIN(o2."id") FROM "Offer" o2 WHERE o2."productId" = o."productId"
);

CREATE UNIQUE INDEX "Offer_one_default_per_product"
  ON "Offer" ("productId")
  WHERE "isDefault";
