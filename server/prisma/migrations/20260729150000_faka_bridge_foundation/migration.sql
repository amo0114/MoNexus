-- FakaBridge foundation (M2): Offer external integration fields + outbox table.
-- Production Xboard callback: POST /plugin/faka-bridge/order-paid (no /api/v1).

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN "externalIntegration" TEXT;
ALTER TABLE "Offer" ADD COLUMN "externalSku" TEXT;

-- Only faka_bridge is recognized; when set, externalSku must be non-empty.
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_faka_bridge_fields_check" CHECK (
  "externalIntegration" IS NULL
  OR (
    "externalIntegration" = 'faka_bridge'
    AND "externalSku" IS NOT NULL
    AND length(btrim("externalSku")) > 0
  )
);

CREATE INDEX "Offer_externalIntegration_externalSku_idx"
  ON "Offer"("externalIntegration", "externalSku");

-- CreateTable
CREATE TABLE "FakaBridgeTask" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "lastError" TEXT,
    "xboardTradeNo" TEXT,
    "requestOrderNo" TEXT NOT NULL,
    "emailSnapshot" TEXT NOT NULL,
    "skuSnapshot" TEXT NOT NULL,
    "periodSnapshot" TEXT NOT NULL DEFAULT 'monthly',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "FakaBridgeTask_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FakaBridgeTask_status_check" CHECK (
      "status" IN ('pending', 'succeeded', 'failed', 'cancelled')
    ),
    CONSTRAINT "FakaBridgeTask_attempts_check" CHECK (
      "attempts" >= 0 AND "maxAttempts" >= 1 AND "attempts" <= "maxAttempts" + 5
    )
);

CREATE UNIQUE INDEX "FakaBridgeTask_orderId_key" ON "FakaBridgeTask"("orderId");
CREATE INDEX "FakaBridgeTask_status_nextAttemptAt_idx" ON "FakaBridgeTask"("status", "nextAttemptAt");
CREATE INDEX "FakaBridgeTask_requestOrderNo_idx" ON "FakaBridgeTask"("requestOrderNo");
CREATE INDEX "FakaBridgeTask_xboardTradeNo_idx" ON "FakaBridgeTask"("xboardTradeNo");

ALTER TABLE "FakaBridgeTask"
  ADD CONSTRAINT "FakaBridgeTask_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
