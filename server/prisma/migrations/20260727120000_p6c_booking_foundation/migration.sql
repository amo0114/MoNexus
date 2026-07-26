-- P6c 预约服务基础：Order.bookingDate 列化（商家排序/提醒免查答案 JSON）
-- + 预约日前提醒去重表。
ALTER TABLE "Order" ADD COLUMN "bookingDate" TIMESTAMP(3);
CREATE INDEX "Order_merchantId_bookingDate_idx" ON "Order"("merchantId", "bookingDate");

CREATE TABLE "BookingReminder" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingReminder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookingReminder_orderId_key" ON "BookingReminder"("orderId");

ALTER TABLE "BookingReminder"
  ADD CONSTRAINT "BookingReminder_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
