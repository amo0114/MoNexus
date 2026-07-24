-- 下单后商品可以调整履约模式。订单必须保留创建时的模式，避免历史人工服务单失去履约出口。
ALTER TABLE "Order" ADD COLUMN "deliveryModeSnapshot" TEXT;

UPDATE "Order" AS "order"
SET "deliveryModeSnapshot" = "product"."deliveryMode"
FROM "Product" AS "product"
WHERE "order"."productId" = "product"."id";

ALTER TABLE "Order" ALTER COLUMN "deliveryModeSnapshot" SET NOT NULL;
ALTER TABLE "Order" ALTER COLUMN "deliveryModeSnapshot" SET DEFAULT 'instant_inventory';

-- 不自动删除历史库存，因为已售/作废记录也属于审计数据。若历史数据含重复项，显式中止部署，
-- 让运维人员先按商品核查并处理，避免静默删除或篡改交付内容。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "InventoryItem"
    GROUP BY "productId", "content"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot add InventoryItem(productId, content) uniqueness: duplicate inventory content exists. Reconcile duplicate records before retrying migration.';
  END IF;
END $$;

CREATE UNIQUE INDEX "InventoryItem_productId_content_key"
ON "InventoryItem"("productId", "content");
