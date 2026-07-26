-- P6a 订阅到期基础：
-- 1) Offer.validityDays（null = 永久，存量语义不变）+ 非负 CHECK。
-- 2) Order.validityDaysSnapshot（下单冻结）与 renewalOfOrderId（续费自关联，
--    RESTRICT——续费链属于审计链，原订单行不可删）。
-- 3) DeliveryRecord.expiresAt（交付时计算；到期只作用于内容访问与 UI，
--    不引入订单状态）。

ALTER TABLE "Offer" ADD COLUMN "validityDays" INTEGER;
ALTER TABLE "Offer"
  ADD CONSTRAINT "Offer_validityDays_positive_check"
    CHECK ("validityDays" IS NULL OR "validityDays" > 0);

ALTER TABLE "Order" ADD COLUMN "validityDaysSnapshot" INTEGER;
ALTER TABLE "Order" ADD COLUMN "renewalOfOrderId" INTEGER;
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_renewalOfOrderId_fkey"
    FOREIGN KEY ("renewalOfOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Order_renewalOfOrderId_idx" ON "Order"("renewalOfOrderId");

ALTER TABLE "DeliveryRecord" ADD COLUMN "expiresAt" TIMESTAMP(3);
