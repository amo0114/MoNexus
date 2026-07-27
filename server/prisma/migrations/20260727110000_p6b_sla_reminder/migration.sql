-- P6b：SLA 超时提醒去重状态（每单最多一封；仅提醒不自动退款——设计决策 ③）。
CREATE TABLE "SlaReminder" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlaReminder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SlaReminder_orderId_key" ON "SlaReminder"("orderId");

ALTER TABLE "SlaReminder"
  ADD CONSTRAINT "SlaReminder_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
