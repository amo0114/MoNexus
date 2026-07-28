-- P7b: auto-provision foundation — merchant webhook configs (versioned),
-- provision tasks (transactional outbox), and the Offer.autoProvision flag.

-- Offer flag: only manual_service offers without a delivery-fields template
-- may enable auto-provision (server-side validation + DB backstop, review ④).
ALTER TABLE "Offer" ADD COLUMN "autoProvision" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_auto_provision_check" CHECK (
    "autoProvision" = false
    OR (
        "deliveryMode" = 'manual_service'
        AND ("deliveryFields" IS NULL OR "deliveryFields" = 'null'::jsonb OR "deliveryFields" = '[]'::jsonb)
    )
);

-- Versioned merchant webhook configs. Rotation/revocation flips status to
-- 'revoked'; pending tasks that reference a revoked config degrade to manual
-- fulfilment (they never re-resolve to a newer config).
CREATE TABLE "MerchantWebhookConfig" (
    "id" SERIAL NOT NULL,
    "merchantId" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "secretCiphertext" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "MerchantWebhookConfig_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "MerchantWebhookConfig"
    ADD CONSTRAINT "MerchantWebhookConfig_status_check" CHECK ("status" IN ('active', 'revoked'));

CREATE INDEX "MerchantWebhookConfig_merchantId_status_idx" ON "MerchantWebhookConfig"("merchantId", "status");

-- At most one active config per merchant. Partial unique index — invisible to
-- the Prisma diff engine (same drift exemption as Offer_one_default_per_product).
CREATE UNIQUE INDEX "MerchantWebhookConfig_one_active_per_merchant"
    ON "MerchantWebhookConfig"("merchantId") WHERE "status" = 'active';

ALTER TABLE "MerchantWebhookConfig"
    ADD CONSTRAINT "MerchantWebhookConfig_merchantId_fkey"
    FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Provision tasks: created inside the order transaction (transactional outbox).
CREATE TABLE "ProvisionTask" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "webhookConfigId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "lastHttpStatus" INTEGER,
    "merchantNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProvisionTask_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ProvisionTask"
    ADD CONSTRAINT "ProvisionTask_status_check" CHECK ("status" IN ('pending', 'succeeded', 'degraded', 'cancelled'));

CREATE UNIQUE INDEX "ProvisionTask_orderId_key" ON "ProvisionTask"("orderId");

CREATE INDEX "ProvisionTask_status_nextAttemptAt_idx" ON "ProvisionTask"("status", "nextAttemptAt");

ALTER TABLE "ProvisionTask"
    ADD CONSTRAINT "ProvisionTask_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProvisionTask"
    ADD CONSTRAINT "ProvisionTask_webhookConfigId_fkey"
    FOREIGN KEY ("webhookConfigId") REFERENCES "MerchantWebhookConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
