-- Generic external fulfillment: an Offer may bind any registered provider id
-- (validated by the application registry). Shape and mutual exclusion stay in
-- the database; existing faka_bridge rows satisfy both new checks.
ALTER TABLE "Offer" DROP CONSTRAINT "Offer_faka_bridge_fields_check";
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_external_integration_fields_check" CHECK (
  "externalIntegration" IS NULL
  OR (
    "externalIntegration" ~ '^[a-z][a-z0-9_]{1,31}$'
    AND "externalSku" IS NOT NULL
    AND length(btrim("externalSku")) > 0
  )
);

ALTER TABLE "Offer" DROP CONSTRAINT "Offer_auto_provision_faka_mutex_check";
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_auto_provision_external_mutex_check" CHECK (
  NOT ("autoProvision" = true AND "externalIntegration" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "FulfillmentJob" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "providerId" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "skuSnapshot" TEXT NOT NULL,
    "inputSnapshot" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "lastError" TEXT,
    "evidence" JSONB,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "FulfillmentJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FulfillmentJob_status_check" CHECK (
      "status" IN ('pending', 'needs_reconcile', 'succeeded', 'failed', 'cancelled')
    ),
    CONSTRAINT "FulfillmentJob_attempts_check" CHECK ("attempts" >= 0 AND "maxAttempts" >= 1)
);

-- CreateIndex
CREATE UNIQUE INDEX "FulfillmentJob_orderId_key" ON "FulfillmentJob"("orderId");
CREATE UNIQUE INDEX "FulfillmentJob_operationKey_key" ON "FulfillmentJob"("operationKey");
CREATE INDEX "FulfillmentJob_status_nextAttemptAt_idx" ON "FulfillmentJob"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "FulfillmentJob" ADD CONSTRAINT "FulfillmentJob_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
