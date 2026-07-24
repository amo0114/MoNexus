-- Product and item state columns remain TEXT in Prisma for backwards-compatible
-- application contracts.  PostgreSQL is nevertheless the final authority for
-- their finite value sets and non-negative commercial counters.
--
-- Validate existing rows before changing the schema.  This migration never
-- silently rewrites legacy product data: an operator must reconcile any bad
-- rows deliberately and rerun the deployment.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Product"
    WHERE "price" <= 0
      OR ("originalPrice" IS NOT NULL AND "originalPrice" < "price")
      OR "stock" < 0
      OR "sales" < 0
      OR "status" NOT IN ('active', 'inactive')
      OR "deliveryMode" NOT IN ('instant_inventory', 'instant_fixed', 'manual_service')
      OR "stockMode" NOT IN ('limited', 'unlimited')
      OR "fixedContentType" NOT IN ('text', 'url')
      OR ("deliveryMode" = 'instant_inventory' AND "stockMode" <> 'limited')
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce Product constraints: reconcile invalid price, originalPrice, stock, sales, status, deliveryMode, stockMode, or fixedContentType values first.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "InventoryItem"
    WHERE "status" NOT IN ('available', 'sold', 'void')
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce InventoryItem status constraint: reconcile invalid status values first.';
  END IF;
END $$;

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_price_positive_check" CHECK ("price" > 0),
  ADD CONSTRAINT "Product_originalPrice_not_less_than_price_check"
    CHECK ("originalPrice" IS NULL OR "originalPrice" >= "price"),
  ADD CONSTRAINT "Product_stock_non_negative_check" CHECK ("stock" >= 0),
  ADD CONSTRAINT "Product_sales_non_negative_check" CHECK ("sales" >= 0),
  ADD CONSTRAINT "Product_status_valid_check"
    CHECK ("status" IN ('active', 'inactive')),
  ADD CONSTRAINT "Product_deliveryMode_valid_check"
    CHECK ("deliveryMode" IN ('instant_inventory', 'instant_fixed', 'manual_service')),
  ADD CONSTRAINT "Product_stockMode_valid_check"
    CHECK ("stockMode" IN ('limited', 'unlimited')),
  ADD CONSTRAINT "Product_fixedContentType_valid_check"
    CHECK ("fixedContentType" IN ('text', 'url')),
  ADD CONSTRAINT "Product_instant_inventory_limited_stock_check"
    CHECK ("deliveryMode" <> 'instant_inventory' OR "stockMode" = 'limited');

ALTER TABLE "InventoryItem"
  ADD CONSTRAINT "InventoryItem_status_valid_check"
    CHECK ("status" IN ('available', 'sold', 'void'));
