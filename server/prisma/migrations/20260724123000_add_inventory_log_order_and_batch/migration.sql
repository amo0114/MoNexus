-- Keep inventory movements attributable without exposing any delivery secret.
-- Existing import rows are given deterministic synthetic batch IDs based on
-- their immutable log ID. This preserves audit history and lets the database
-- require a batch reference for every import from now on.
ALTER TABLE "InventoryLog"
  ADD COLUMN "orderId" INTEGER,
  ADD COLUMN "batchId" UUID;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "InventoryLog"
    WHERE "action" NOT IN ('import', 'void', 'sale', 'capacity_adjust')
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce InventoryLog action constraint: reconcile invalid actions first.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "InventoryLog"
    WHERE ("action" = 'sale' AND ("orderId" IS NULL OR "delta" <> -1))
       OR ("action" <> 'sale' AND "orderId" IS NOT NULL)
       OR ("action" = 'import' AND "delta" <= 0)
       OR ("action" = 'void' AND "delta" >= 0)
       OR ("action" = 'capacity_adjust' AND "delta" = 0)
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce InventoryLog movement constraint: reconcile inconsistent order references or quantities first.';
  END IF;
END $$;

UPDATE "InventoryLog"
SET "batchId" = (
  substr(lpad(to_hex("id"), 32, '0'), 1, 8) || '-' ||
  substr(lpad(to_hex("id"), 32, '0'), 9, 4) || '-' ||
  substr(lpad(to_hex("id"), 32, '0'), 13, 4) || '-' ||
  substr(lpad(to_hex("id"), 32, '0'), 17, 4) || '-' ||
  substr(lpad(to_hex("id"), 32, '0'), 21, 12)
)::uuid
WHERE "action" = 'import';

ALTER TABLE "InventoryLog"
  ADD CONSTRAINT "InventoryLog_action_valid_check"
    CHECK ("action" IN ('import', 'void', 'sale', 'capacity_adjust')),
  ADD CONSTRAINT "InventoryLog_sale_order_check"
    CHECK (("action" = 'sale' AND "orderId" IS NOT NULL) OR ("action" <> 'sale' AND "orderId" IS NULL)),
  ADD CONSTRAINT "InventoryLog_batch_check"
    CHECK (("action" = 'import' AND "batchId" IS NOT NULL) OR ("action" <> 'import' AND "batchId" IS NULL)),
  ADD CONSTRAINT "InventoryLog_delta_by_action_check"
    CHECK (
      ("action" = 'import' AND "delta" > 0)
      OR ("action" = 'void' AND "delta" < 0)
      OR ("action" = 'sale' AND "delta" = -1)
      OR ("action" = 'capacity_adjust' AND "delta" <> 0)
    ),
  ADD CONSTRAINT "InventoryLog_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "InventoryLog_orderId_key" ON "InventoryLog"("orderId");
CREATE UNIQUE INDEX "InventoryLog_batchId_key" ON "InventoryLog"("batchId");
CREATE INDEX "InventoryLog_batchId_idx" ON "InventoryLog"("batchId");
