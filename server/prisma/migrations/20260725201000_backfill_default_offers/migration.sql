-- P4a migration 2/3: backfill one default Offer per product and point the
-- related rows at it. Idempotent by construction (WHERE ... IS NULL guards);
-- runs entirely inside the migration transaction.
--
-- Reconciliation queries (run manually after deploy, both must return 0):
--   SELECT count(*) FROM "Product" p WHERE NOT EXISTS
--     (SELECT 1 FROM "Offer" o WHERE o."productId" = p.id);
--   SELECT count(*) FROM "InventoryItem" WHERE "offerId" IS NULL;

-- One default Offer per product, copying the commercial + fulfillment columns.
INSERT INTO "Offer" (
  "productId", "name", "price", "originalPrice", "status",
  "deliveryMode", "stockMode", "stock", "fixedContent", "fixedContentType",
  "sales", "sortOrder", "createdAt"
)
SELECT
  p."id", '默认规格', p."price", p."originalPrice", 'active',
  p."deliveryMode", p."stockMode", p."stock", p."fixedContent", p."fixedContentType",
  p."sales", 0, p."createdAt"
FROM "Product" p
WHERE NOT EXISTS (SELECT 1 FROM "Offer" o WHERE o."productId" = p."id");

-- Point inventory, orders and audit rows at the product's default Offer.
-- "default" = the lowest-id Offer of the product, which after the INSERT above
-- is exactly the backfilled row for every pre-P4a product.
UPDATE "InventoryItem" i
SET "offerId" = (
  SELECT o."id" FROM "Offer" o
  WHERE o."productId" = i."productId"
  ORDER BY o."id" ASC LIMIT 1
)
WHERE i."offerId" IS NULL;

UPDATE "Order" ord
SET "offerId" = (
  SELECT o."id" FROM "Offer" o
  WHERE o."productId" = ord."productId"
  ORDER BY o."id" ASC LIMIT 1
)
WHERE ord."offerId" IS NULL;

UPDATE "InventoryLog" l
SET "offerId" = (
  SELECT o."id" FROM "Offer" o
  WHERE o."productId" = l."productId"
  ORDER BY o."id" ASC LIMIT 1
)
WHERE l."offerId" IS NULL;
