-- P4a migration 3/3: tighten InventoryItem.offerId to NOT NULL, only after the
-- 20260725201000 backfill. The guard makes the failure mode explicit instead
-- of a cryptic constraint violation: an operator must reconcile orphans and
-- rerun the deployment. Order.offerId deliberately stays nullable (pre-P4a
-- compatibility convention, same as the display snapshot columns).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "InventoryItem" WHERE "offerId" IS NULL) THEN
    RAISE EXCEPTION
      'Cannot tighten InventoryItem.offerId: NULL rows remain, run/verify the 20260725201000 backfill first.';
  END IF;
END $$;

ALTER TABLE "InventoryItem" ALTER COLUMN "offerId" SET NOT NULL;
