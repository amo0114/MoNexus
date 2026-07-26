-- P6a：订阅到期提醒去重状态表（发送成功才落 stage，失败下轮重试）。
CREATE TABLE "SubscriptionReminder" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "lastStage" TEXT NOT NULL,
    "lastSentAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionReminder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SubscriptionReminder_orderId_key" ON "SubscriptionReminder"("orderId");

ALTER TABLE "SubscriptionReminder"
  ADD CONSTRAINT "SubscriptionReminder_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SubscriptionReminder"
  ADD CONSTRAINT "SubscriptionReminder_lastStage_valid_check"
    CHECK ("lastStage" IN ('pre', 'expired'));
