-- P5.5 运维收尾基础迁移（评审修订全部落在此处）：
-- 1) InventoryLog.orderId 由唯一降级为普通索引——同一订单需并存 sale 与
--    refund_void / refund_restock 两行；action 词表与 delta/订单关联 CHECK 同步扩展。
-- 2) LowStockNotice：SKU 级低库存告警状态（按非空 offerId 去重，规避 PG
--    含空列唯一约束无法限制多行 NULL 的陷阱）。
-- 3) Order 时间范围聚合索引（SKU 报表）。
-- 4) 历史一次性回填：公开销量改净值（按非退款订单重算）；历史退款单的
--    即时库存卡密 sold → void（交付即泄密，永不回售）。不补写历史
--    InventoryLog——流水只忠实记录启用本策略之后的变更。

-- 1) orderId 去唯一
DROP INDEX "InventoryLog_orderId_key";
CREATE INDEX "InventoryLog_orderId_idx" ON "InventoryLog"("orderId");

-- action 词表 + 订单关联 + delta 规则扩展
ALTER TABLE "InventoryLog"
  DROP CONSTRAINT "InventoryLog_action_valid_check",
  DROP CONSTRAINT "InventoryLog_sale_order_check",
  DROP CONSTRAINT "InventoryLog_delta_by_action_check";

ALTER TABLE "InventoryLog"
  ADD CONSTRAINT "InventoryLog_action_valid_check"
    CHECK ("action" IN ('import', 'void', 'sale', 'capacity_adjust', 'refund_void', 'refund_restock')),
  ADD CONSTRAINT "InventoryLog_sale_order_check"
    CHECK (
      ("action" IN ('sale', 'refund_void', 'refund_restock') AND "orderId" IS NOT NULL)
      OR ("action" NOT IN ('sale', 'refund_void', 'refund_restock') AND "orderId" IS NULL)
    ),
  ADD CONSTRAINT "InventoryLog_delta_by_action_check"
    CHECK (
      ("action" = 'import' AND "delta" > 0)
      OR ("action" = 'void' AND "delta" < 0)
      OR ("action" = 'sale' AND "delta" = -1)
      OR ("action" = 'capacity_adjust' AND "delta" <> 0)
      OR ("action" = 'refund_void' AND "delta" = 0)
      OR ("action" = 'refund_restock' AND "delta" = 1)
    );

-- 2) SKU 级低库存告警状态
CREATE TABLE "LowStockNotice" (
    "id" SERIAL NOT NULL,
    "offerId" INTEGER NOT NULL,
    "isLow" BOOLEAN NOT NULL DEFAULT false,
    "lastAvailable" INTEGER NOT NULL,
    "lastNotifiedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LowStockNotice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LowStockNotice_offerId_key" ON "LowStockNotice"("offerId");

ALTER TABLE "LowStockNotice"
  ADD CONSTRAINT "LowStockNotice_offerId_fkey"
    FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3) 报表聚合索引
CREATE INDEX "Order_merchantId_createdAt_idx" ON "Order"("merchantId", "createdAt");
CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");

-- 4) 历史回填
-- 公开销量改净值：按非退款订单重算（计数器此前只增不减）。
UPDATE "Product" p
SET "sales" = sub.cnt
FROM (
  SELECT pr.id, COALESCE(o.cnt, 0) AS cnt
  FROM "Product" pr
  LEFT JOIN (
    SELECT "productId", COUNT(*) AS cnt
    FROM "Order"
    WHERE "status" <> 'refunded'
    GROUP BY "productId"
  ) o ON o."productId" = pr.id
) sub
WHERE p.id = sub.id AND p."sales" <> sub.cnt;

UPDATE "Offer" f
SET "sales" = sub.cnt
FROM (
  SELECT of2.id, COALESCE(o.cnt, 0) AS cnt
  FROM "Offer" of2
  LEFT JOIN (
    SELECT "offerId", COUNT(*) AS cnt
    FROM "Order"
    WHERE "status" <> 'refunded' AND "offerId" IS NOT NULL
    GROUP BY "offerId"
  ) o ON o."offerId" = of2.id
) sub
WHERE f.id = sub.id AND f."sales" <> sub.cnt;

-- 历史退款单的卡密报废（策略生效前的存量）。
UPDATE "InventoryItem" i
SET "status" = 'void'
FROM "Order" o
WHERE i."orderId" = o.id
  AND o."status" = 'refunded'
  AND i."status" = 'sold';
